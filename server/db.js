"use strict";
/**
 * db.js — SQLite database layer (WAL mode, production hardened)
 * Adds: audit_log table for control action tracking
 */

const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { getExplicitDataDir, getPortableDataRoot } = require("./runtimeEnvPaths");
const { resolvedDbDir, getNewRoot, isMigrationComplete } = require("./storagePaths");
const baselineUpgradeCore = require("./baselineUpgradeCore");
const { decideBaselineAnchor, DEFAULT_PAC_WAKE_THRESHOLD_W } = require("./baselineAnchorDecisionCore");
const { decideCounterHealthAudits } = require("./counterHealthAuditCore");

function resolveDataDir() {
  const portableRoot = getPortableDataRoot();
  if (portableRoot) {
    const dir = path.join(portableRoot, "db");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const explicit = getExplicitDataDir();
  if (explicit) return explicit;
  if (process.env.INVERTER_DATA_DIR) return process.env.INVERTER_DATA_DIR;
  if (process.env.ADSI_DATA_DIR) return process.env.ADSI_DATA_DIR;
  const isPackaged = __dirname.includes("app.asar") || (typeof process.resourcesPath === "string");
  const programDataRoot =
    process.env.PROGRAMDATA ||
    process.env.ALLUSERSPROFILE ||
    (process.platform === "win32"
      ? "C:\\ProgramData"
      : process.env.INVERTER_STORAGE_DIR ||
        path.join(os.homedir(), ".inverter-dashboard"));
  const packagedStorage =
    process.platform === "win32"
      ? path.join(programDataRoot, "Inverter-Dashboard", "db")
      : (process.env.INVERTER_STORAGE_DIR
          ? path.join(process.env.INVERTER_STORAGE_DIR, "db")
          : path.join(programDataRoot, "db"));
  const repoStorage = path.join(__dirname, "..", "storage", "db");

  const dbDir = isPackaged ? packagedStorage : repoStorage;
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  return dbDir;
}

function pad2(n) {
  return String(Math.trunc(Number(n) || 0)).padStart(2, "0");
}

function localDateStr(ts = Date.now()) {
  const d = new Date(Number(ts || Date.now()));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function monthKeyFromTs(ts) {
  const d = new Date(Number(ts || 0));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function iterateMonthKeys(startTs, endTs) {
  const start = new Date(Number(startTs || 0));
  const end = new Date(Number(endTs || 0));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return [];
  if (start.getTime() > end.getTime()) return [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const stop = new Date(end.getFullYear(), end.getMonth(), 1);
  const out = [];
  while (cur.getTime() <= stop.getTime()) {
    out.push(`${cur.getFullYear()}-${pad2(cur.getMonth() + 1)}`);
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}
const DATA_DIR = resolveDataDir();

fs.mkdirSync(DATA_DIR, { recursive: true });

// On Windows, %PROGRAMDATA% directories default to Users:RX only.
// Ensure the DB directory is writable so SQLite can open in WAL mode.
(function ensureWritableOnWindows() {
  if (process.platform !== "win32") return;
  if (!DATA_DIR.toLowerCase().includes("programdata")) return;
  try {
    // Quick probe: try creating a temp file to verify write access.
    const probe = path.join(DATA_DIR, ".write-probe");
    fs.writeFileSync(probe, "", { flag: "w" });
    fs.unlinkSync(probe);
  } catch {
    // Write failed — attempt to fix ACL.
    try {
      const { spawnSync } = require("child_process");
      const r = spawnSync("icacls", [DATA_DIR, "/grant", "Users:(OI)(CI)M", "/T", "/Q"], {
        windowsHide: true,
        timeout: 15000,
      });
      if (r.error) throw r.error;
      console.log("[db] Granted Users write access to", DATA_DIR);
    } catch (err) {
      console.warn("[db] Could not grant Users write access to", DATA_DIR, ":", err.message);
    }
  }
})();

const DB_PATH = path.join(DATA_DIR, "adsi.db");
const MAIN_DB_PENDING_REPLACEMENT_PATH = path.join(
  DATA_DIR,
  ".pending-main-db-replacement.json",
);
const ARCHIVE_DIR = (() => {
  const dir = path.join(DATA_DIR, "archive");
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
})();
const SUMMARY_SOLAR_START_H = 5;
const SUMMARY_SOLAR_END_H = 18;
const SUMMARY_MAX_GAP_S = 120;
const SUMMARY_PAC_KWH_MAX_DT_MS = 30000; // 30 s cap — mirrors COMPUTED_ENERGY_MAX_DT_MS in exporter.js
const ARCHIVE_BATCH_SIZE = 2000; // reduced from 5000 — smaller batches keep event-loop pauses under ~80ms
// LRU bound for open archive month-DBs. Each entry pins prepared statements + a
// per-DB SQLite page cache (8 MB) + WAL state + file descriptors; without this
// cap the Map at line below grew unbounded as forecast crons / exports /
// replication touched older months, contributing to the gateway memory creep
// documented in audits/2026-05-11/db-read-write-health.md §4.4 (H2). The cap is
// generous enough that the forecast 30-45 day history sweep stays resident
// across consecutive cron runs (typically spans 2-3 months) while still
// bounding worst-case memory after long uptime. Map iteration order is
// insertion order in JS, so we use delete+re-insert on access to maintain
// LRU ordering and evict from .keys().next() on overflow.
const ARCHIVE_DB_CACHE_MAX_ENTRIES = 6;
const ARCHIVE_DB_CACHE = new Map();
const ARCHIVE_DB_REPLACE_LOCKS = new Set();
// Telemetry for the LRU eviction policy above. Operators can read these via
// getArchiveCacheStats() to confirm the bound is doing useful work; spike in
// evictions correlated with forecast cron windows is the expected signal.
let _archiveLruEvictionCount = 0;
let _archiveLruLastEvictedKey = null;
let _archiveLruLastEvictedAtMs = 0;
const STARTUP_COMPACT_MAX_BYTES = 64 * 1024 * 1024;
// ─── Row-count safety caps for the archive-aware "...RangeAll" readers ──────
// better-sqlite3 is synchronous and these helpers materialize the ENTIRE range
// into a JS Map + Array + sort. The route-level guard bounds *time* (366 days)
// but NOT row COUNT, so a high-poll-rate plant requesting a wide range could
// run the Node process out of heap. Because Node shares the gateway box with
// the Electron renderer AND the Python poller, an OOM there can drag the whole
// Windows machine into swap-thrash and a hard freeze (the reported whole-PC
// crash). We now abort with a clear, catchable error BEFORE the heap blows —
// strictly safer than the old "caller will OOM loudly" behaviour, and a no-op
// for every legitimately-sized export. Operator-overridable via env for
// gateways with ample RAM that genuinely need a bigger one-shot pull.
const READINGS_RANGE_MAX_ROWS = Math.max(
  100000,
  Number(process.env.ADSI_READINGS_RANGE_MAX_ROWS) || 2000000,
);
const ENERGY5MIN_RANGE_MAX_ROWS = Math.max(
  100000,
  Number(process.env.ADSI_ENERGY5MIN_RANGE_MAX_ROWS) || 2000000,
);
function _rangeRowCapError(kind, rows, cap, envVar) {
  const err = new Error(
    `${kind} query range too large: ${rows.toLocaleString()} rows exceeds the ` +
      `${cap.toLocaleString()}-row safety cap. Narrow the date range or use a ` +
      `per-inverter export. (Raise ${envVar} only if the gateway has spare RAM.)`,
  );
  err.code = "RANGE_ROW_CAP";
  err.userMessage = `The selected range returns too many rows (over ${cap.toLocaleString()}). Please choose a shorter date range.`;
  return err;
}
const READING_STORAGE_COLUMNS = [
  "id",
  "ts",
  "inverter",
  "unit",
  "pac",
  "kwh",
  "alarm",
  "online",
];
const READING_VALUE_COLUMNS = READING_STORAGE_COLUMNS.filter((col) => col !== "id");
const READING_SELECT_SQL = READING_VALUE_COLUMNS.join(",");
const READING_TABLE_DDL = `
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  inverter  INTEGER NOT NULL,
  unit      INTEGER NOT NULL,
  pac       REAL DEFAULT 0,
  kwh       REAL DEFAULT 0,
  alarm     INTEGER DEFAULT 0,
  online    INTEGER DEFAULT 1
`;
const ARCHIVE_READING_TABLE_DDL = `
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  inverter  INTEGER NOT NULL,
  unit      INTEGER NOT NULL,
  pac       REAL DEFAULT 0,
  kwh       REAL DEFAULT 0,
  alarm     INTEGER DEFAULT 0,
  online    INTEGER DEFAULT 1
`;
// Mirrors the hot `alarms` table column-for-column (minus AUTOINCREMENT —
// archives preserve the hot id so dedup keys stay stable across migrations).
// See ensureArchiveSchema() for the index pair that matches the hot DB.
const ARCHIVE_ALARM_TABLE_DDL = `
  id             INTEGER PRIMARY KEY,
  ts             INTEGER NOT NULL,
  inverter       INTEGER NOT NULL,
  unit           INTEGER NOT NULL,
  alarm_code     TEXT,
  alarm_value    INTEGER,
  severity       TEXT DEFAULT 'fault',
  cleared_ts     INTEGER,
  acknowledged   INTEGER DEFAULT 0,
  updated_ts     INTEGER NOT NULL DEFAULT 0,
  stop_reason_id INTEGER
`;
// Mirrors the hot `audit_log` table column-for-column (minus AUTOINCREMENT —
// archives preserve the hot id so cross-tier joins stay stable). Added in
// v2.11.1 to close the same retention-deletes-data gap that alarms had in
// v2.11.0-beta.10: pruneOldData() used to run unconditional
// `DELETE FROM audit_log WHERE ts < auditCutoff` so the operator's control-
// action history could evaporate permanently if `auditRetainDays` was ever
// set low. Now audit rows migrate to the same monthly shards used for
// alarms / readings / energy_5min, and queryAuditRangeArchiveAware() merges
// hot + archive on read.
const ARCHIVE_AUDIT_TABLE_DDL = `
  id        INTEGER PRIMARY KEY,
  ts        INTEGER NOT NULL,
  operator  TEXT DEFAULT 'OPERATOR',
  inverter  INTEGER NOT NULL,
  node      INTEGER DEFAULT 0,
  action    TEXT NOT NULL,
  scope     TEXT DEFAULT 'single',
  result    TEXT DEFAULT 'ok',
  ip        TEXT DEFAULT '',
  reason    TEXT DEFAULT ''
`;
// v2.11.1-beta.1 — mirror the hot `inverter_stop_reasons` schema column-for-
// column (minus AUTOINCREMENT, so the hot id is preserved across migrations).
// Drilldown panel resolves alarm.stop_reason_id via findStopReasonByIdArchiveAware
// so an alarm whose row has migrated to the alarm shard still surfaces its
// captured StopReason snapshot.
const ARCHIVE_STOP_REASONS_TABLE_DDL = `
  id              INTEGER PRIMARY KEY,
  inverter_id     INTEGER NOT NULL,
  inverter_ip     TEXT NOT NULL,
  slave           INTEGER NOT NULL,
  node            INTEGER NOT NULL,
  read_at_ms      INTEGER NOT NULL,
  event_at_ms     INTEGER,
  trigger_source  TEXT NOT NULL DEFAULT 'manual',
  alarm_id        INTEGER,
  pot_ac          REAL,
  vpv             REAL,
  vac1            REAL, vac2 REAL, vac3 REAL,
  iac1            REAL, iac2 REAL,
  frec1           REAL, frec2 REAL, frec3 REAL,
  cos             REAL,
  temp            INTEGER,
  alarma          INTEGER NOT NULL DEFAULT 0,
  motparo         INTEGER NOT NULL DEFAULT 0,
  motparo_label   TEXT,
  alarmas1        INTEGER, alarmas2 INTEGER, flags INTEGER,
  ref1            INTEGER, pos1 INTEGER,
  ref2            INTEGER, pos2 INTEGER,
  timeout_band    INTEGER,
  debug_desc      INTEGER NOT NULL DEFAULT 0,
  struct_month    INTEGER, struct_day INTEGER,
  struct_hour     INTEGER, struct_min INTEGER,
  raw_hex         TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  updated_ts      INTEGER NOT NULL DEFAULT 0
`;
// Note (v2.11.1-beta.1) — inverter_5min_param archive deferred to a follow-
// up beta. The hot table gains many Slice β diagnostic columns via
// `ensureColumn` migrations (parce_kwh, qac_var_avg, tempint_c_*, zpos/zneg
// kohm, vpv_n/p_v, time_to_connect_*, alarms_inst_32_max, analog_in_*,
// pt100_*, inverter_state_raw_last, etc.) that a static archive DDL would
// silently drop. A future release will mirror the schema dynamically from
// PRAGMA table_info(inverter_5min_param) so the archive shard tracks every
// column added by future migrations. Until then `paramRetainDays` keeps
// its 7-day floor — bounded loss, acceptable per the 2026-05-22 audit.

fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

function sanitizePreservedSettings(entriesRaw) {
  const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
  const deduped = new Map();
  for (const entry of entries) {
    const key = String(entry?.key || "").trim().slice(0, 128);
    if (!key) continue;
    deduped.set(key, {
      key,
      value: String(entry?.value ?? ""),
    });
  }
  return Array.from(deduped.values()).sort((a, b) =>
    String(a?.key || "").localeCompare(String(b?.key || "")),
  );
}

function readPendingMainDbReplacement() {
  try {
    if (!fs.existsSync(MAIN_DB_PENDING_REPLACEMENT_PATH)) return null;
    const parsed = JSON.parse(
      fs.readFileSync(MAIN_DB_PENDING_REPLACEMENT_PATH, "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    return {
      tempName: path.basename(String(parsed?.tempName || "").trim()),
      size: Math.max(0, Number(parsed?.size || 0)),
      mtimeMs: Math.max(0, Number(parsed?.mtimeMs || 0)),
      stagedAt: Math.max(0, Number(parsed?.stagedAt || 0)),
      fileApplied: Boolean(parsed?.fileApplied),
      fileAppliedAt: Math.max(0, Number(parsed?.fileAppliedAt || 0)),
      preservedSettings: sanitizePreservedSettings(parsed?.preservedSettings),
    };
  } catch (_) {
    return null;
  }
}

function writePendingMainDbReplacement(entryRaw) {
  const entry = entryRaw && typeof entryRaw === "object" ? entryRaw : null;
  if (!entry) {
    try {
      fs.unlinkSync(MAIN_DB_PENDING_REPLACEMENT_PATH);
    } catch (_) {
      // Ignore missing manifest cleanup failures.
    }
    return;
  }
  const payload = {
    tempName: path.basename(String(entry?.tempName || "").trim()),
    size: Math.max(0, Number(entry?.size || 0)),
    mtimeMs: Math.max(0, Number(entry?.mtimeMs || 0)),
    stagedAt: Math.max(0, Number(entry?.stagedAt || 0)),
    fileApplied: Boolean(entry?.fileApplied),
    fileAppliedAt: Math.max(0, Number(entry?.fileAppliedAt || 0)),
    preservedSettings: sanitizePreservedSettings(entry?.preservedSettings),
  };
  const tempPath = `${MAIN_DB_PENDING_REPLACEMENT_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, MAIN_DB_PENDING_REPLACEMENT_PATH);
}

function stagePendingMainDbReplacement({
  tempName,
  size = 0,
  mtimeMs = 0,
  preservedSettings = [],
}) {
  const safeTempName = path.basename(String(tempName || "").trim());
  if (!safeTempName) {
    throw new Error("Invalid staged main DB replacement payload.");
  }
  const previous = readPendingMainDbReplacement();
  const oldTempName = path.basename(String(previous?.tempName || "").trim());
  if (
    oldTempName &&
    oldTempName !== safeTempName &&
    /\.tmp$/i.test(oldTempName)
  ) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, oldTempName));
    } catch (_) {
      // Ignore stale temp cleanup failures.
    }
  }
  const staged = {
    tempName: safeTempName,
    size: Math.max(0, Number(size || 0)),
    mtimeMs: Math.max(0, Number(mtimeMs || 0)),
    stagedAt: Date.now(),
    fileApplied: false,
    fileAppliedAt: 0,
    preservedSettings: sanitizePreservedSettings(preservedSettings),
  };
  writePendingMainDbReplacement(staged);
  return staged;
}

function discardPendingMainDbReplacement(tempName = "") {
  const pending = readPendingMainDbReplacement();
  if (!pending) {
    return { cleared: false, tempRemoved: false };
  }
  const expectedTempName = path.basename(String(tempName || "").trim());
  const pendingTempName = path.basename(String(pending?.tempName || "").trim());
  if (expectedTempName && pendingTempName && pendingTempName !== expectedTempName) {
    return { cleared: false, tempRemoved: false, skipped: true };
  }
  let tempRemoved = false;
  if (pendingTempName) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, pendingTempName));
      tempRemoved = true;
    } catch (_) {
      tempRemoved = false;
    }
  }
  writePendingMainDbReplacement(null);
  return { cleared: true, tempRemoved };
}

function validateSqliteFileSync(filePath) {
  const target = String(filePath || "").trim();
  if (!target || !fs.existsSync(target)) {
    throw new Error("SQLite file is missing.");
  }
  const fd = fs.openSync(target, "r");
  let probe;
  try {
    probe = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0);
    if (bytesRead < 16 || probe.toString("utf8", 0, 16) !== "SQLite format 3\u0000") {
      throw new Error("SQLite header is invalid.");
    }
  } finally {
    fs.closeSync(fd);
  }

  let verifyDb = null;
  try {
    verifyDb = new Database(target, { readonly: true, fileMustExist: true });
    const quickCheck = String(
      verifyDb.prepare("PRAGMA quick_check(1)").pluck().get() || "",
    )
      .trim()
      .toLowerCase();
    if (quickCheck !== "ok") {
      throw new Error(`SQLite quick_check failed: ${quickCheck || "unknown error"}`);
    }
  } finally {
    try {
      verifyDb?.close();
    } catch (_) {
      // Ignore validation close failures.
    }
  }
  return true;
}

function applyPendingMainDbReplacementFileSync() {
  const pending = readPendingMainDbReplacement();
  if (!pending) return { applied: 0, failed: 0, pending: 0 };
  if (pending.fileApplied) {
    return { applied: 0, failed: 0, pending: 1, awaitingSettingsRestore: true };
  }
  const tempName = path.basename(String(pending?.tempName || "").trim());
  const tempPath = path.join(DATA_DIR, tempName);
  if (!tempName || !fs.existsSync(tempPath)) {
    return {
      applied: 0,
      failed: 1,
      pending: 1,
      error: "Staged main DB snapshot is missing.",
    };
  }
  try {
    validateSqliteFileSync(tempPath);
    for (const suffix of ["-wal", "-shm", ""]) {
      try {
        fs.unlinkSync(`${DB_PATH}${suffix}`);
      } catch (_) {
        // Ignore missing current DB files.
      }
    }
    fs.renameSync(tempPath, DB_PATH);
    const targetMtimeMs = Math.max(0, Number(pending?.mtimeMs || 0));
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      fs.utimesSync(DB_PATH, mtime, mtime);
    }
    writePendingMainDbReplacement({
      ...pending,
      tempName: "",
      fileApplied: true,
      fileAppliedAt: Date.now(),
    });
    return { applied: 1, failed: 0, pending: 1, awaitingSettingsRestore: true };
  } catch (err) {
    return {
      applied: 0,
      failed: 1,
      pending: 1,
      error: String(err?.message || err),
    };
  }
}

const pendingMainDbFileApplyResult = applyPendingMainDbReplacementFileSync();

// v2.8.10 Phase C: pre-open integrity probe + auto-restore from rotating
// backup slots. Before the live `new Database(DB_PATH)` call, we cheaply
// inspect the main DB for corruption (sqlite header + quick_check in a
// throwaway readonly handle). If it fails, we swap in the newer of the
// two 2-hour backup slots written by server/index.js runPeriodicBackup.
// This converts "app fails to boot after torn write" into "app boots,
// shows banner, and loses at most ~2h of readings that the poller refills".
const BACKUP_DIR_FOR_RESTORE = path.join(DATA_DIR, "backups");
const startupIntegrityResult = {
  mainDb: "unknown",          // "ok" | "corrupt" | "missing" | "error"
  restored: false,             // true if we swapped in a backup slot
  restoredFromSlot: null,      // 0 | 1 | null
  restoredAt: 0,               // epoch ms
  unrescuable: false,          // true if main + all backups were corrupt → fresh DB
  unrescuableAt: 0,            // epoch ms when we gave up
  quickCheck: "",              // raw PRAGMA quick_check(1) result
  backupCandidates: [],        // [{slot, path, size, mtimeMs, ok}]
  checkedAt: 0,
  // v2.8.14 nightly-reboot diagnostics. Populated from the ADSI_LAST_SHUTDOWN_JSON
  // env var written by electron/main.js via electron/shutdownReason.js. When the
  // env bridge isn't available (e.g. running the server standalone in tests)
  // we fall back to reading the archived prev-marker file directly.
  lastShutdown: null,          // { classification, priorReason, sentinelWasPresent, checkedAt }
};

(function _loadLastShutdownSnapshot() {
  const raw = String(process.env.ADSI_LAST_SHUTDOWN_JSON || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        startupIntegrityResult.lastShutdown = parsed;
        return;
      }
    } catch (_) { /* fall through to file read */ }
  }
  // Fallback: read prev-marker file directly. Kept simple — if anything
  // throws, we leave lastShutdown as null and the banner stays silent.
  try {
    const programData = process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
    const prevPath = path.join(programData, "Inverter-Dashboard", "lifecycle", "shutdown-reason.prev.json");
    if (fs.existsSync(prevPath)) {
      const prev = JSON.parse(fs.readFileSync(prevPath, "utf8"));
      startupIntegrityResult.lastShutdown = {
        classification: prev?.reason === "unexpected-shutdown" ? "unexpected" : "graceful",
        priorReason: prev,
        sentinelWasPresent: true,
        checkedAt: Number(prev?.timestamp || 0),
      };
    }
  } catch (_) { /* leave lastShutdown null */ }
})();

function _sqliteFileLooksValidSync(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return false;
    const st = fs.statSync(targetPath);
    if (!st.isFile() || st.size < 64) return false;
    const fd = fs.openSync(targetPath, "r");
    try {
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      return header.toString("utf8", 0, 15) === "SQLite format 3";
    } finally {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
  } catch (_) {
    return false;
  }
}

function _probeDbIntegritySync(targetPath) {
  let probe = null;
  try {
    // BR-Mi2 (audit 2026-05-28 §3) — better-sqlite3 is synchronous, so a
    // Promise timeout cannot bound `quick_check` (it runs on this thread). The
    // realistic startup hazard is the file being lock-contended, not the check
    // hanging: `quick_check(1)` only scans page structure and is bounded by
    // file size (ms on a healthy DB). We pass a short busy timeout + open the
    // probe read-only so a lock held by another opener fails fast with a clear
    // SQLITE_BUSY rather than blocking startup on the default ~5 s busy wait.
    probe = new Database(targetPath, { readonly: true, fileMustExist: true, timeout: 2000 });
    const qc = String(probe.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
    return { ok: qc === "ok", quickCheck: qc };
  } catch (err) {
    return { ok: false, quickCheck: String(err?.message || err) };
  } finally {
    try { probe?.close(); } catch (_) { /* ignore */ }
  }
}

function _listBackupSlotsForRestore() {
  const slots = [];
  try {
    if (!fs.existsSync(BACKUP_DIR_FOR_RESTORE)) return slots;
    for (const slot of [0, 1]) {
      const p = path.join(BACKUP_DIR_FOR_RESTORE, `adsi_backup_${slot}.db`);
      if (!_sqliteFileLooksValidSync(p)) continue;
      try {
        const st = fs.statSync(p);
        slots.push({ slot, path: p, size: st.size, mtimeMs: st.mtimeMs, ok: null });
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  // Newest first
  slots.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return slots;
}

function _autoRestoreMainDbFromBackupSync() {
  const mainExists = fs.existsSync(DB_PATH);
  startupIntegrityResult.checkedAt = Date.now();
  if (!mainExists) {
    startupIntegrityResult.mainDb = "missing";
    console.warn(`[DB] adsi.db missing at ${DB_PATH} — fresh DB will be created on open`);
    return;
  }
  if (!_sqliteFileLooksValidSync(DB_PATH)) {
    startupIntegrityResult.mainDb = "corrupt";
    startupIntegrityResult.quickCheck = "header invalid";
  } else {
    const probe = _probeDbIntegritySync(DB_PATH);
    startupIntegrityResult.quickCheck = probe.quickCheck;
    startupIntegrityResult.mainDb = probe.ok ? "ok" : "corrupt";
  }
  if (startupIntegrityResult.mainDb === "ok") {
    console.log("[DB] Startup quick_check: ok");
    return;
  }
  console.error(
    `[DB] Main DB corrupt at startup (${startupIntegrityResult.quickCheck}). ` +
    `Attempting auto-restore from rotating backup slots.`,
  );
  const candidates = _listBackupSlotsForRestore();
  startupIntegrityResult.backupCandidates = candidates.map((c) => ({ ...c }));
  for (const cand of candidates) {
    const probe = _probeDbIntegritySync(cand.path);
    cand.ok = probe.ok;
    if (!probe.ok) {
      console.warn(`[DB] Backup slot ${cand.slot} also corrupt: ${probe.quickCheck}`);
      continue;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${DB_PATH}.corrupt-${stamp}`;
    try {
      for (const suffix of ["-wal", "-shm"]) {
        try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch (_) { /* ignore */ }
      }
      try { fs.renameSync(DB_PATH, quarantinePath); }
      catch (err) { console.warn(`[DB] Quarantine rename failed: ${err.message}`); }
      fs.copyFileSync(cand.path, DB_PATH);
      startupIntegrityResult.restored = true;
      startupIntegrityResult.restoredFromSlot = cand.slot;
      startupIntegrityResult.restoredAt = Date.now();
      // The restored file is known-good — clear the corrupt flag so the
      // post-open quick_check path can assert "ok". `restored` remains
      // true so the renderer banner fires.
      startupIntegrityResult.mainDb = "ok";
      startupIntegrityResult.quickCheck = "restored-from-backup";
      console.log(
        `[DB] Auto-restored adsi.db from backup slot ${cand.slot} ` +
        `(${cand.size} bytes, mtime=${new Date(cand.mtimeMs).toISOString()}). ` +
        `Previous corrupt DB quarantined at ${quarantinePath}.`,
      );
      return;
    } catch (err) {
      console.error(`[DB] Auto-restore from slot ${cand.slot} failed: ${err.message}`);
    }
  }
  // Last-resort fallback: the main DB is corrupt and no backup rescued us.
  // Opening a file that isn't a valid SQLite DB throws SQLITE_NOTADB from
  // better-sqlite3, crashing the server. For a 24/7 monitoring system it is
  // better to quarantine the dead file and boot with a fresh empty DB —
  // the poller will fill it with new readings and the operator can perform
  // a cloud restore if they need the historical record back.
  if (!_sqliteFileLooksValidSync(DB_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const quarantinePath = `${DB_PATH}.unrescuable-${stamp}`;
    try {
      fs.renameSync(DB_PATH, quarantinePath);
      for (const suffix of ["-wal", "-shm"]) {
        try { fs.unlinkSync(`${DB_PATH}${suffix}`); } catch (_) { /* ignore */ }
      }
      startupIntegrityResult.unrescuable = true;
      startupIntegrityResult.unrescuableAt = Date.now();
      startupIntegrityResult.quickCheck = "quarantined-fresh-db";
      console.error(
        `[DB] Unrescuable DB quarantined at ${quarantinePath}. ` +
        `Booting with a fresh empty DB — live polling and cloud restore can recover data.`,
      );
    } catch (err) {
      console.error(`[DB] Unrescuable-quarantine rename failed: ${err.message}`);
    }
  } else {
    console.error("[DB] No usable backup slot found — opening corrupt DB as-is (live data may be inaccessible).");
  }
}

_autoRestoreMainDbFromBackupSync();

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");  // WAL+NORMAL is crash-safe; FULL adds fsync per commit that blocks the event loop
db.pragma("busy_timeout = 1500");   // Low timeout: better-sqlite3 blocks event loop during contention; fail fast
db.pragma("cache_size = -64000");
db.pragma("temp_store = memory");
db.pragma("mmap_size = 268435456");
// Pin the WAL auto-checkpoint threshold explicitly (1000 pages ≈ 4 MB, the
// SQLite default) so continuous poller writes keep checkpointing the WAL in
// small PASSIVE batches instead of letting it grow large and forcing a single
// long synchronous flush. Made explicit (not relying on the driver default) so
// the bound can't drift if a future better-sqlite3/SQLite changes the default;
// audited 2026-06-01 as part of the freeze/crash hardening pass.
db.pragma("wal_autocheckpoint = 1000");

// Post-open quick_check — covers the case where the file validated readonly
// but became inconsistent after WAL playback on open.
try {
  const qc = String(db.prepare("PRAGMA quick_check(1)").pluck().get() || "").trim().toLowerCase();
  startupIntegrityResult.quickCheck = qc;
  if (qc !== "ok") {
    startupIntegrityResult.mainDb = "corrupt";
    console.error(`[DB] Post-open quick_check FAILED: ${qc}`);
  } else if (startupIntegrityResult.mainDb !== "corrupt") {
    startupIntegrityResult.mainDb = "ok";
    console.log("[DB] Post-open quick_check: ok");
  }
} catch (qcErr) {
  console.error("[DB] Post-open quick_check error:", qcErr.message);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    ${READING_TABLE_DDL}
  );
  CREATE INDEX IF NOT EXISTS idx_r_ts      ON readings(ts);
  CREATE INDEX IF NOT EXISTS idx_r_inv_ts  ON readings(inverter, unit, ts);

  CREATE TABLE IF NOT EXISTS energy_5min (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    inverter  INTEGER NOT NULL,
    kwh_inc   REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_e5_inv_ts ON energy_5min(inverter, ts);
  CREATE INDEX IF NOT EXISTS idx_e5_ts     ON energy_5min(ts);

  CREATE TABLE IF NOT EXISTS availability_5min (
    ts              INTEGER PRIMARY KEY,
    online_count    INTEGER NOT NULL DEFAULT 0,
    expected_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS alarms (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    inverter     INTEGER NOT NULL,
    unit         INTEGER NOT NULL,
    alarm_code   TEXT,
    alarm_value  INTEGER,
    severity     TEXT DEFAULT 'fault',
    cleared_ts   INTEGER,
    acknowledged INTEGER DEFAULT 0,
    updated_ts   INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_a_ts     ON alarms(ts);
  CREATE INDEX IF NOT EXISTS idx_a_inv_ts ON alarms(inverter, ts);
  -- v2.11.x Slice κ.3 — loadCriticalPatterns runs WHERE inverter=? AND unit=? AND ts > ?
  -- per node on every fleet-endpoint hit (108 calls). This index makes the
  -- query an index range scan rather than inv-filtered scan + unit filter.
  CREATE INDEX IF NOT EXISTS idx_a_inv_unit_ts ON alarms(inverter, unit, ts);

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    operator  TEXT DEFAULT 'OPERATOR',
    inverter  INTEGER NOT NULL,
    node      INTEGER DEFAULT 0,
    action    TEXT NOT NULL,
    scope     TEXT DEFAULT 'single',
    result    TEXT DEFAULT 'ok',
    ip        TEXT DEFAULT '',
    reason    TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_audit_inv_ts ON audit_log(inverter, ts);

  CREATE TABLE IF NOT EXISTS daily_report (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT NOT NULL,
    inverter  INTEGER NOT NULL,
    kwh_total REAL DEFAULT 0,
    pac_peak  REAL DEFAULT 0,
    pac_avg   REAL DEFAULT 0,
    uptime_s  INTEGER DEFAULT 0,
    alarm_count INTEGER DEFAULT 0,
    control_count INTEGER DEFAULT 0,
    availability_pct REAL DEFAULT 0,
    performance_pct REAL DEFAULT 0,
    node_uptime_s INTEGER DEFAULT 0,
    expected_node_uptime_s INTEGER DEFAULT 0,
    expected_nodes INTEGER DEFAULT 4,
    rated_kw REAL DEFAULT 0,
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    UNIQUE(date, inverter)
  );

  CREATE TABLE IF NOT EXISTS daily_readings_summary (
    date TEXT NOT NULL,
    inverter INTEGER NOT NULL,
    unit INTEGER NOT NULL,
    sample_count INTEGER DEFAULT 0,
    online_samples INTEGER DEFAULT 0,
    pac_online_sum REAL DEFAULT 0,
    pac_online_count INTEGER DEFAULT 0,
    pac_peak REAL DEFAULT 0,
    first_ts INTEGER DEFAULT 0,
    last_ts INTEGER DEFAULT 0,
    first_kwh REAL DEFAULT 0,
    last_kwh REAL DEFAULT 0,
    last_online INTEGER DEFAULT 0,
    intervals_json TEXT DEFAULT '[]',
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY(date, inverter, unit)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT,
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    from_machine TEXT NOT NULL CHECK (from_machine IN ('gateway', 'remote')),
    to_machine   TEXT NOT NULL CHECK (to_machine IN ('gateway', 'remote')),
    from_name    TEXT NOT NULL DEFAULT '',
    message      TEXT NOT NULL,
    read_ts      INTEGER DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_chat_to_machine_id
    ON chat_messages(to_machine, id);

  CREATE TABLE IF NOT EXISTS forecast_dayahead (
    date       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    time_hms   TEXT NOT NULL,
    kwh_inc    REAL NOT NULL DEFAULT 0,
    kwh_lo     REAL DEFAULT 0,
    kwh_hi     REAL DEFAULT 0,
    source     TEXT DEFAULT 'service',
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY(date, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_fd_ts      ON forecast_dayahead(ts);
  CREATE INDEX IF NOT EXISTS idx_fd_date_ts ON forecast_dayahead(date, ts);

  CREATE TABLE IF NOT EXISTS forecast_dayahead_immutable (
    date         TEXT NOT NULL,
    issuance_id  TEXT NOT NULL,
    generated_ts INTEGER NOT NULL,
    slot         INTEGER NOT NULL,
    time_hms     TEXT NOT NULL,
    kwh_inc      REAL NOT NULL,
    kwh_lo       REAL NOT NULL,
    kwh_hi       REAL NOT NULL,
    source       TEXT NOT NULL DEFAULT 'service',
    PRIMARY KEY(date, issuance_id, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_fdi_date_generated_ts
    ON forecast_dayahead_immutable(date, generated_ts DESC);

  CREATE TABLE IF NOT EXISTS forecast_dayahead_issuance (
    issuance_id            TEXT PRIMARY KEY,
    date                   TEXT NOT NULL,
    generated_ts           INTEGER NOT NULL,
    source                 TEXT NOT NULL DEFAULT 'service',
    expected_slot_count    INTEGER NOT NULL,
    basis_checksum         TEXT NOT NULL,
    weather_snapshot_json  TEXT,
    weather_snapshot_sha256 TEXT,
    constraint_snapshot_json TEXT,
    constraint_snapshot_sha256 TEXT,
    model_sha256           TEXT,
    artifact_sha256        TEXT,
    base_run_audit_id      INTEGER,
    created_by             TEXT NOT NULL DEFAULT 'forecast_engine'
  );
  CREATE INDEX IF NOT EXISTS idx_fdi_issuance_date_generated_ts
    ON forecast_dayahead_issuance(date, generated_ts DESC);

  CREATE TABLE IF NOT EXISTS forecast_intraday_adjusted (
    date       TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    slot       INTEGER NOT NULL,
    time_hms   TEXT NOT NULL,
    kwh_inc    REAL NOT NULL DEFAULT 0,
    kwh_lo     REAL DEFAULT 0,
    kwh_hi     REAL DEFAULT 0,
    source     TEXT DEFAULT 'service',
    updated_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    series_run_id TEXT,
    PRIMARY KEY(date, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_fia_ts      ON forecast_intraday_adjusted(ts);
  CREATE INDEX IF NOT EXISTS idx_fia_date_ts ON forecast_intraday_adjusted(date, ts);

  CREATE TABLE IF NOT EXISTS forecast_intraday_run_audit (
    id                       INTEGER PRIMARY KEY,
    target_date              TEXT    NOT NULL,
    generated_ts             INTEGER NOT NULL,
    cutoff_slot              INTEGER NOT NULL,
    base_run_audit_id        INTEGER,
    base_forecast_updated_ts INTEGER,
    algorithm_version        TEXT    NOT NULL,
    execution_mode           TEXT    NOT NULL DEFAULT 'active',
    actual_source            TEXT    NOT NULL DEFAULT 'pac_loss_adjusted',
    eligible_slots           INTEGER NOT NULL DEFAULT 0,
    excluded_cap_slots       INTEGER NOT NULL DEFAULT 0,
    excluded_outage_slots    INTEGER NOT NULL DEFAULT 0,
    excluded_quality_slots   INTEGER NOT NULL DEFAULT 0,
    excluded_curtailed_slots INTEGER NOT NULL DEFAULT 0,
    recent_log_ratio         REAL,
    session_log_ratio        REAL,
    strength                 REAL,
    half_life_minutes        REAL,
    dayahead_total_kwh       REAL,
    nowcast_total_kwh        REAL,
    constraint_mode          TEXT,
    run_status               TEXT    NOT NULL DEFAULT 'success',
    notes_json               TEXT,
    series_run_id            TEXT,
    output_updated_ts        INTEGER,
    authoritative_algorithm  TEXT,
    challenger_status        TEXT,
    authoritative_write_status TEXT,
    configured_mode          TEXT,
    prior_series_preserved   INTEGER,
    UNIQUE(target_date, generated_ts)
  );
  CREATE INDEX IF NOT EXISTS idx_fira_date_ts
    ON forecast_intraday_run_audit(target_date, generated_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_fira_status
    ON forecast_intraday_run_audit(target_date, run_status);

  CREATE TABLE IF NOT EXISTS solcast_snapshots (
    forecast_day    TEXT    NOT NULL,
    slot            INTEGER NOT NULL,
    ts_local        INTEGER NOT NULL,
    period_end_utc  TEXT,
    period          TEXT,
    forecast_mw     REAL,
    forecast_lo_mw  REAL,
    forecast_hi_mw  REAL,
    est_actual_mw   REAL,
    forecast_kwh    REAL,
    forecast_lo_kwh REAL,
    forecast_hi_kwh REAL,
    est_actual_kwh  REAL,
    pulled_ts       INTEGER NOT NULL,
    source          TEXT    NOT NULL,
    updated_ts      INTEGER NOT NULL,
    PRIMARY KEY (forecast_day, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_ss_day ON solcast_snapshots(forecast_day);

  CREATE TABLE IF NOT EXISTS forecast_run_audit (
    id                          INTEGER PRIMARY KEY,
    target_date                 TEXT    NOT NULL,
    generated_ts                INTEGER NOT NULL,
    generator_mode              TEXT    NOT NULL,
    provider_used               TEXT    NOT NULL,
    provider_expected           TEXT,
    forecast_variant            TEXT    NOT NULL,
    weather_source              TEXT,
    solcast_snapshot_day         TEXT,
    solcast_snapshot_pulled_ts   INTEGER,
    solcast_snapshot_age_sec     INTEGER,
    solcast_snapshot_coverage_ratio REAL,
    solcast_snapshot_source      TEXT,
    solcast_mean_blend           REAL,
    solcast_reliability          REAL,
    solcast_primary_mode         INTEGER NOT NULL DEFAULT 0,
    solcast_raw_total_kwh        REAL,
    solcast_applied_total_kwh    REAL,
    physics_total_kwh            REAL,
    hybrid_total_kwh             REAL,
    final_forecast_total_kwh     REAL,
    ml_residual_total_kwh        REAL,
    error_class_total_kwh        REAL,
    bias_total_kwh               REAL,
    shape_skipped_for_solcast    INTEGER NOT NULL DEFAULT 0,
    run_status                   TEXT    NOT NULL,
    solcast_freshness_class      TEXT,
    is_authoritative_runtime     INTEGER NOT NULL DEFAULT 1,
    is_authoritative_learning    INTEGER NOT NULL DEFAULT 1,
    superseded_by_run_audit_id   INTEGER,
    replaces_run_audit_id        INTEGER,
    attempt_number               INTEGER NOT NULL DEFAULT 1,
    notes_json                   TEXT,
    UNIQUE(target_date, generated_ts, forecast_variant)
  );
  CREATE INDEX IF NOT EXISTS idx_fra_target ON forecast_run_audit(target_date);
  CREATE INDEX IF NOT EXISTS idx_fra_variant_ts ON forecast_run_audit(forecast_variant, generated_ts DESC);

  CREATE TABLE IF NOT EXISTS forecast_error_compare_daily (
    id                        INTEGER PRIMARY KEY,
    target_date               TEXT    NOT NULL,
    run_audit_id              INTEGER NOT NULL DEFAULT 0,
    generator_mode            TEXT,
    provider_used             TEXT    NOT NULL,
    provider_expected         TEXT,
    forecast_variant          TEXT,
    weather_source            TEXT,
    solcast_freshness_class   TEXT,
    total_forecast_kwh        REAL,
    total_forecast_lo_kwh     REAL,
    total_forecast_hi_kwh     REAL,
    total_actual_kwh          REAL,
    total_abs_error_kwh       REAL,
    daily_wape_pct            REAL,
    daily_mape_pct            REAL,
    daily_total_ape_pct       REAL,
    usable_slot_count         INTEGER NOT NULL DEFAULT 0,
    masked_slot_count         INTEGER NOT NULL DEFAULT 0,
    available_actual_slots    INTEGER NOT NULL DEFAULT 0,
    available_forecast_slots  INTEGER NOT NULL DEFAULT 0,
    manual_masked_slots       INTEGER NOT NULL DEFAULT 0,
    cap_masked_slots          INTEGER NOT NULL DEFAULT 0,
    operational_masked_slots  INTEGER NOT NULL DEFAULT 0,
    include_in_error_memory   INTEGER NOT NULL DEFAULT 0,
    include_in_source_scoring INTEGER NOT NULL DEFAULT 0,
    comparison_quality        TEXT    NOT NULL DEFAULT 'review',
    computed_ts               INTEGER NOT NULL,
    notes_json                TEXT,
    UNIQUE(target_date, run_audit_id)
  );

  CREATE TABLE IF NOT EXISTS forecast_error_compare_slot (
    id                        INTEGER PRIMARY KEY,
    target_date               TEXT    NOT NULL,
    run_audit_id              INTEGER NOT NULL DEFAULT 0,
    daily_compare_id          INTEGER,
    slot                      INTEGER NOT NULL,
    ts_local                  INTEGER NOT NULL DEFAULT 0,
    time_hms                  TEXT    NOT NULL DEFAULT '',
    provider_used             TEXT    NOT NULL,
    forecast_kwh              REAL,
    actual_kwh                REAL,
    solcast_kwh               REAL,
    physics_kwh               REAL,
    hybrid_baseline_kwh       REAL,
    ml_residual_kwh           REAL,
    error_class_bias_kwh      REAL,
    memory_bias_kwh           REAL,
    signed_error_kwh          REAL,
    abs_error_kwh             REAL,
    ape_pct                   REAL,
    normalized_error          REAL,
    opportunity_kwh           REAL,
    slot_weather_bucket       TEXT,
    day_regime                TEXT,
    actual_present            INTEGER NOT NULL DEFAULT 0,
    forecast_present          INTEGER NOT NULL DEFAULT 0,
    solcast_present           INTEGER NOT NULL DEFAULT 0,
    usable_for_metrics        INTEGER NOT NULL DEFAULT 0,
    usable_for_error_memory   INTEGER NOT NULL DEFAULT 0,
    manual_constraint_mask    INTEGER NOT NULL DEFAULT 0,
    cap_dispatch_mask         INTEGER NOT NULL DEFAULT 0,
    curtailed_mask            INTEGER NOT NULL DEFAULT 0,
    operational_mask          INTEGER NOT NULL DEFAULT 0,
    solar_mask                INTEGER NOT NULL DEFAULT 0,
    rad_wm2                   REAL,
    cloud_pct                 REAL,
    support_weight            REAL,
    UNIQUE(target_date, run_audit_id, slot)
  );
  CREATE TABLE IF NOT EXISTS scheduled_maintenance (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter   INTEGER NOT NULL DEFAULT 0,
    start_ts   INTEGER NOT NULL,
    end_ts     INTEGER NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_ts INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_maintenance_time ON scheduled_maintenance(start_ts, end_ts);

  CREATE TABLE IF NOT EXISTS plant_cap_schedules (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    name                     TEXT NOT NULL DEFAULT 'Schedule',
    enabled                  INTEGER NOT NULL DEFAULT 1,
    start_time               TEXT NOT NULL DEFAULT '08:00',
    stop_time                TEXT NOT NULL DEFAULT '17:00',
    upper_mw                 REAL,
    lower_mw                 REAL,
    sequence_mode            TEXT DEFAULT NULL,
    sequence_custom_json     TEXT NOT NULL DEFAULT '[]',
    cooldown_sec             INTEGER DEFAULT NULL,
    current_state            TEXT NOT NULL DEFAULT 'waiting',
    active_session_id        TEXT DEFAULT NULL,
    total_stop_actions       INTEGER NOT NULL DEFAULT 0,
    total_start_actions      INTEGER NOT NULL DEFAULT 0,
    inverter_stop_count_json TEXT NOT NULL DEFAULT '{}',
    continuous_run_minutes   INTEGER NOT NULL DEFAULT 0,
    safety_pause_reason      TEXT DEFAULT NULL,
    watchdog_last_tick_at    INTEGER DEFAULT NULL,
    last_activated_at        INTEGER DEFAULT NULL,
    last_run_date            TEXT DEFAULT NULL,
    created_ts               INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    updated_ts               INTEGER NOT NULL DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

  CREATE TABLE IF NOT EXISTS substation_metered_energy (
    date         TEXT NOT NULL,
    ts           INTEGER NOT NULL,
    mwh          REAL NOT NULL,
    entered_by   TEXT DEFAULT 'admin',
    entered_at   INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    updated_by   TEXT,
    updated_at   INTEGER,
    PRIMARY KEY (date, ts)
  );

  CREATE TABLE IF NOT EXISTS substation_meter_daily (
    date            TEXT PRIMARY KEY,
    sync_time       TEXT,
    desync_time     TEXT,
    total_gen_mwhr  REAL,
    net_kwh         REAL,
    deviation_pct   REAL,
    entered_by      TEXT DEFAULT 'admin',
    entered_at      INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );

  -- Day-ahead locked snapshot (v2.8+): immutable frozen Solcast P10/P50/P90
  -- captured at or before 10 AM local for the NEXT trading day. First write
  -- per (forecast_day, slot) wins; subsequent captures are no-ops.
  CREATE TABLE IF NOT EXISTS solcast_dayahead_locked (
    forecast_day    TEXT    NOT NULL,   -- YYYY-MM-DD the forecast is FOR (day D+1)
    slot            INTEGER NOT NULL,   -- 0..287 (5-min slot of day)
    ts_local        INTEGER NOT NULL,   -- Unix ms, start of slot in Asia/Manila
    period_end_utc  TEXT,
    period          TEXT,                -- e.g. "PT5M"
    p50_mw          REAL,                -- Solcast forecast_mw at capture time
    p10_mw          REAL,                -- Solcast forecast_lo_mw
    p90_mw          REAL,                -- Solcast forecast_hi_mw
    p50_kwh         REAL,
    p10_kwh         REAL,
    p90_kwh         REAL,
    spread_mw       REAL,                -- p90_mw - p10_mw
    spread_pct_cap  REAL,                -- spread_mw / plant_cap_mw * 100 (robust; NOT divided by p50)
    captured_ts     INTEGER NOT NULL,    -- Unix ms when we froze this
    captured_local  TEXT    NOT NULL,    -- "YYYY-MM-DDTHH:MM:SS" Asia/Manila
    capture_reason  TEXT    NOT NULL,    -- 'scheduled_0600' | 'scheduled_0955' | 'manual' | 'backfill_approx'
    solcast_source  TEXT    NOT NULL,    -- 'toolkit' | 'api'
    plant_cap_mw    REAL,                -- plant capacity at capture time
    PRIMARY KEY (forecast_day, slot)
  );
  CREATE INDEX IF NOT EXISTS idx_sdl_captured_ts ON solcast_dayahead_locked(captured_ts);
  CREATE INDEX IF NOT EXISTS idx_sdl_capture_reason ON solcast_dayahead_locked(capture_reason);

  -- Full append-only Solcast pull history (v2.8+): every autoFetchSolcastSnapshots()
  -- call appends rows for all pulled slots. Used to measure band-collapse trajectory
  -- and feed the spread-weighted learning loop. 90-day retention via prune cron.
  CREATE TABLE IF NOT EXISTS solcast_snapshot_history (
    forecast_day    TEXT    NOT NULL,
    slot            INTEGER NOT NULL,
    captured_ts     INTEGER NOT NULL,    -- unique per pull
    pulled_ts       INTEGER NOT NULL,    -- Solcast's own pulled_ts for the record
    p50_mw          REAL,
    p10_mw          REAL,
    p90_mw          REAL,
    est_actual_mw   REAL,
    age_sec         INTEGER,              -- at capture time, how old was Solcast's data
    solcast_source  TEXT,
    PRIMARY KEY (forecast_day, slot, captured_ts)
  );
  CREATE INDEX IF NOT EXISTS idx_ssh_day_captured ON solcast_snapshot_history(forecast_day, captured_ts);
  CREATE INDEX IF NOT EXISTS idx_ssh_day_slot ON solcast_snapshot_history(forecast_day, slot);
  CREATE INDEX IF NOT EXISTS idx_ssh_captured_ts ON solcast_snapshot_history(captured_ts);

  -- v2.9.0 Slice B: hardware-counter state (upserted on every poll).
  -- One row per (inverter, unit); constant-size table (~91 rows).
  CREATE TABLE IF NOT EXISTS inverter_counter_state (
    inverter      INTEGER NOT NULL,
    unit          INTEGER NOT NULL,
    ts_ms         INTEGER NOT NULL,
    etotal_kwh    INTEGER DEFAULT 0,
    parce_kwh     INTEGER DEFAULT 0,
    rtc_ms        INTEGER,
    rtc_valid     INTEGER NOT NULL DEFAULT 0,
    rtc_drift_s   REAL,
    pac_w         INTEGER DEFAULT 0,
    fac_hz        REAL,
    alarm_32      INTEGER DEFAULT 0,
    counter_advancing INTEGER DEFAULT 1,
    updated_ts    INTEGER NOT NULL
                  DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY (inverter, unit)
  );
  CREATE INDEX IF NOT EXISTS idx_ics_updated ON inverter_counter_state(updated_ts);

  -- v2.9.0 Slice B: per-day baselines (one row per unit per local date).
  -- v2.9.1: extended with eod_clean_* columns capturing the day's
  --         post-1800H rolling-last hardware-counter snapshot. Tomorrow's
  --         baseline is derived from this row's eod_clean fields, not from
  --         tomorrow's first-poll value (which may be a transient bad read).
  CREATE TABLE IF NOT EXISTS inverter_counter_baseline (
    inverter           INTEGER NOT NULL,
    unit               INTEGER NOT NULL,
    date_key           TEXT NOT NULL,
    etotal_baseline    INTEGER NOT NULL,
    parce_baseline     INTEGER NOT NULL,
    baseline_ts_ms     INTEGER NOT NULL,
    source             TEXT NOT NULL DEFAULT 'poll',
    etotal_eod_clean   INTEGER,
    parce_eod_clean    INTEGER,
    eod_clean_ts_ms    INTEGER,
    eod_clean_pac_w    INTEGER,
    updated_ts         INTEGER NOT NULL
                       DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    PRIMARY KEY (inverter, unit, date_key)
  );
  CREATE INDEX IF NOT EXISTS idx_icb_date    ON inverter_counter_baseline(date_key);
  CREATE INDEX IF NOT EXISTS idx_icb_updated ON inverter_counter_baseline(updated_ts);

  -- v2.9.0 Slice D: clock-sync attempt log.
  CREATE TABLE IF NOT EXISTS inverter_clock_sync_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER NOT NULL,
    inverter         INTEGER NOT NULL,
    unit             INTEGER NOT NULL,
    trigger          TEXT NOT NULL,
    target_iso       TEXT,
    drift_before_s   REAL,
    drift_after_s    REAL,
    accepted         INTEGER DEFAULT 0,
    error            TEXT,
    updated_ts       INTEGER NOT NULL
                     DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_icsl_ts  ON inverter_clock_sync_log(ts);
  CREATE INDEX IF NOT EXISTS idx_icsl_inv ON inverter_clock_sync_log(inverter, ts);

  -- v2.10.0 Slice B: StopReason snapshots (DebugDesc + telemetry at fault).
  -- Populated by Python via POST /api/stop-reasons/internal/capture either
  -- on operator refresh (trigger_source='manual') or on poller-detected
  -- alarm transition (trigger_source='alarm_transition'). De-dup via the
  -- (inverter_ip, slave, node, fingerprint) UNIQUE so re-reads of the
  -- same physical event don't duplicate rows.
  CREATE TABLE IF NOT EXISTS inverter_stop_reasons (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter_id     INTEGER NOT NULL,
    inverter_ip     TEXT NOT NULL,
    slave           INTEGER NOT NULL,
    node            INTEGER NOT NULL,
    read_at_ms      INTEGER NOT NULL,
    event_at_ms     INTEGER,
    trigger_source  TEXT NOT NULL DEFAULT 'manual',
    alarm_id        INTEGER,
    pot_ac          REAL,
    vpv             REAL,
    vac1            REAL, vac2 REAL, vac3 REAL,
    iac1            REAL, iac2 REAL,
    frec1           REAL, frec2 REAL, frec3 REAL,
    cos             REAL,
    temp            INTEGER,
    alarma          INTEGER NOT NULL DEFAULT 0,
    motparo         INTEGER NOT NULL DEFAULT 0,
    motparo_label   TEXT,
    alarmas1        INTEGER, alarmas2 INTEGER, flags INTEGER,
    ref1            INTEGER, pos1 INTEGER,
    ref2            INTEGER, pos2 INTEGER,
    timeout_band    INTEGER,
    debug_desc      INTEGER NOT NULL DEFAULT 0,
    struct_month    INTEGER, struct_day INTEGER,
    struct_hour     INTEGER, struct_min INTEGER,
    raw_hex         TEXT NOT NULL,
    fingerprint     TEXT NOT NULL,
    updated_ts      INTEGER NOT NULL
                    DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    UNIQUE(inverter_ip, slave, node, fingerprint)
  );
  CREATE INDEX IF NOT EXISTS idx_isr_lookup ON inverter_stop_reasons(inverter_ip, slave, node, read_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_isr_alarm  ON inverter_stop_reasons(alarm_id) WHERE alarm_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_isr_event  ON inverter_stop_reasons(event_at_ms DESC) WHERE event_at_ms IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_isr_inv_ts ON inverter_stop_reasons(inverter_id, read_at_ms DESC);

  -- v2.10.0 Slice B: ARRAYHISTMOTPARO snapshots (lifetime stop-motive
  -- counters; one row per refresh). Slot 30 of counters_json is the TOTAL
  -- counter; slots 0..29 map to MOTIVO_PARO codes (server/motiveLabels.js).
  CREATE TABLE IF NOT EXISTS inverter_stop_histogram (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter_id     INTEGER NOT NULL,
    inverter_ip     TEXT NOT NULL,
    slave           INTEGER NOT NULL,
    read_at_ms      INTEGER NOT NULL,
    total_count     INTEGER NOT NULL,
    counters_json   TEXT NOT NULL,
    raw_hex         TEXT NOT NULL,
    updated_ts      INTEGER NOT NULL
                    DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_ish_inv_ts ON inverter_stop_histogram(inverter_ip, slave, read_at_ms DESC);

  -- v2.10.x Slice ε: standard-Modbus stop-reason ring buffer cross-check
  -- On-demand read of regs 30078–30108 (5-slot history) per inverter/slave
  -- for validation against vendor SCOPE data.
  CREATE TABLE IF NOT EXISTS inverter_stop_reasons_std (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter_id     INTEGER NOT NULL,
    inverter_ip     TEXT NOT NULL,
    slave           INTEGER NOT NULL,
    slot            INTEGER NOT NULL,           -- 0–4 ring-buffer slot
    timestamp_iso   TEXT NOT NULL,              -- ISO 8601 (UTC) reconstructed from y/m/d/h/m
    motive_code     INTEGER NOT NULL,           -- 0–30 per motive lookup table
    motive_name     TEXT,                       -- MOTIVO_PARO_* symbol for display
    read_at_ms      INTEGER NOT NULL,           -- wall-clock when read() was invoked
    captured_at_ms  INTEGER,                    -- event datetime → ms (for sorting)
    source          TEXT NOT NULL DEFAULT 'standard_modbus',
    updated_ts      INTEGER NOT NULL
                    DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    UNIQUE(inverter_ip, slave, slot, timestamp_iso, motive_code)
  );
  CREATE INDEX IF NOT EXISTS idx_iss_lookup ON inverter_stop_reasons_std(inverter_ip, slave, read_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_iss_slot ON inverter_stop_reasons_std(inverter_ip, slave, slot);

  -- v2.10.0 Slice C: serial-number change audit (forever-retained service
  -- record).  Every successful Read mints a session token; every Send
  -- captures the prior serial via mandatory pre-Read so before+after are
  -- always recorded, even on verify_failed.
  CREATE TABLE IF NOT EXISTS serial_change_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter_id     INTEGER NOT NULL,
    inverter_ip     TEXT NOT NULL,
    slave           INTEGER NOT NULL,
    acted_at_ms     INTEGER NOT NULL,
    acted_by        TEXT,
    fmt             TEXT NOT NULL,
    old_serial      TEXT NOT NULL,
    new_serial      TEXT NOT NULL,
    verify_passed   INTEGER NOT NULL DEFAULT 0,
    outcome         TEXT NOT NULL,
    error_detail    TEXT,
    updated_ts      INTEGER NOT NULL
                    DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_scl_inv_ts ON serial_change_log(inverter_ip, acted_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_scl_outcome ON serial_change_log(outcome, acted_at_ms DESC);

  -- v2.11.x firmware-version homogeneity. Firmware strings ride the SAME
  -- FC11 Report-Slave-ID payload the serial feature already reads -- this
  -- is a projection of the existing serial fleet scan, never a second
  -- Modbus sweep.  Invariant the operator audits: every node runs the
  -- same firmware.  inverter_firmware_state is the current snapshot
  -- (one row per (inverter_ip, slave), upserted each scan);
  -- firmware_drift_log appends when a node's (model|main|aux) tuple
  -- changes between scans (the post-board-swap signature -- dual of the
  -- serial-relocation guard).  Node owns all writes (Python read-only).
  CREATE TABLE IF NOT EXISTS inverter_firmware_state (
    inverter_ip     TEXT NOT NULL,
    slave           INTEGER NOT NULL,
    inverter_id     INTEGER NOT NULL DEFAULT 0,
    model_code      TEXT,
    firmware_main   TEXT,
    firmware_aux    TEXT,
    canonical_match INTEGER,   -- 1 ok / 0 drift / NULL unknown-this-scan
    first_seen_ms   INTEGER NOT NULL,
    last_seen_ms    INTEGER NOT NULL,
    PRIMARY KEY (inverter_ip, slave)
  );
  CREATE INDEX IF NOT EXISTS idx_ifs_inv ON inverter_firmware_state(inverter_ip);

  CREATE TABLE IF NOT EXISTS firmware_drift_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter_id     INTEGER NOT NULL DEFAULT 0,
    inverter_ip     TEXT NOT NULL,
    slave           INTEGER NOT NULL,
    old_tuple       TEXT,
    new_tuple       TEXT,
    detected_at_ms  INTEGER NOT NULL,
    scan_by         TEXT,
    note            TEXT,
    updated_ts      INTEGER NOT NULL
                    DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_fdl_inv_ts ON firmware_drift_log(inverter_ip, detected_at_ms DESC);

  -- v2.11.x Slice κ.3: critical-pattern auto-block ledger.
  --
  -- Operator rule (2026-05-11): when alarm-pattern 0x0240 or 0x0210 recurs
  -- (≥ 2 episodes in 48 h) on any node of an inverter, the inverter must
  -- STOP automatically and remain blocked from manual control until the
  -- operator clicks "Confirmed" (after physically inspecting + fixing the
  -- root cause). One active row per inverter at a time -- acked_at_ms IS
  -- NULL is the "active block" predicate. Once acked the row stays for
  -- forensic history; re-triggering creates a new row.
  CREATE TABLE IF NOT EXISTS inverter_critical_blocks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    inverter            INTEGER NOT NULL,
    created_at_ms       INTEGER NOT NULL,
    pattern_key         TEXT NOT NULL,
    pattern_hex         TEXT NOT NULL,
    pattern_label       TEXT,
    triggering_slave    INTEGER,
    count_in_window     INTEGER,
    latest_episode_ts   INTEGER,
    stop_issued_at_ms   INTEGER,
    stop_result         TEXT,
    last_reenforced_ms  INTEGER,
    reenforce_count     INTEGER NOT NULL DEFAULT 0,
    acked_at_ms         INTEGER,
    acked_by            TEXT,
    ack_note            TEXT,
    updated_ts          INTEGER NOT NULL
                        DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  );
  CREATE INDEX IF NOT EXISTS idx_icb_active   ON inverter_critical_blocks(inverter, acked_at_ms);
  CREATE INDEX IF NOT EXISTS idx_icb_inv_ts   ON inverter_critical_blocks(inverter, created_at_ms DESC);

  -- v2.11.x Field Calibration (Phases 2-4): per-write audit ledger and
  -- snapshot trail.  Plan: plans/2026-05-12-inverter-calibration-tool.md
  -- Every successful Read mints a baseline snapshot; every Write captures
  -- before+after+verify result with operator + session id.  Retention:
  -- calibration_write_log = 5 years (regulatory), snapshots = 1 year.
  CREATE TABLE IF NOT EXISTS calibration_write_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_utc          INTEGER NOT NULL,
    session_id      TEXT    NOT NULL,
    inverter_id     INTEGER NOT NULL,
    inverter_ip     TEXT    NOT NULL,
    slave           INTEGER NOT NULL,
    reg_offset      INTEGER NOT NULL,
    param_name      TEXT    NOT NULL,
    value_before    INTEGER,
    value_requested INTEGER NOT NULL,
    value_after     INTEGER,
    verify_ok       INTEGER NOT NULL DEFAULT 0,
    operator        TEXT,
    auth_method     TEXT,
    error_detail    TEXT,
    notes           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cwl_session ON calibration_write_log(session_id, ts_utc);
  CREATE INDEX IF NOT EXISTS idx_cwl_inv_ts  ON calibration_write_log(inverter_id, slave, ts_utc DESC);

  CREATE TABLE IF NOT EXISTS calibration_snapshot (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_utc            INTEGER NOT NULL,
    inverter_id       INTEGER NOT NULL,
    inverter_ip       TEXT    NOT NULL,
    slave             INTEGER NOT NULL,
    source            TEXT    NOT NULL,    -- 'baseline' | 'post-write' | 'periodic'
    session_id        TEXT,
    reg_block_hex     TEXT    NOT NULL,    -- space-separated hex for offsets 80..94
    valid_cfg_code    INTEGER,
    model_code        TEXT,
    firmware_main     TEXT,
    serial            TEXT,
    notes             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_csnap_inv_ts ON calibration_snapshot(inverter_id, slave, ts_utc DESC);
  CREATE INDEX IF NOT EXISTS idx_csnap_session ON calibration_snapshot(session_id);

  CREATE TABLE IF NOT EXISTS calibration_session_log (
    session_id        TEXT    PRIMARY KEY,
    inverter_id       INTEGER NOT NULL,
    slave             INTEGER NOT NULL,
    operator          TEXT,
    started_at_ms     INTEGER NOT NULL,
    ended_at_ms       INTEGER,
    end_reason        TEXT,          -- 'operator' | 'timeout' | 'guard_abort' | 'system'
    write_count       INTEGER NOT NULL DEFAULT 0,
    consign_writes    INTEGER NOT NULL DEFAULT 0,
    notes             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cs_inv_ts ON calibration_session_log(inverter_id, started_at_ms DESC);

  -- v2.10.x All Parameters Data — per-inverter, per-node, per-5-minute
  -- aggregated parameter snapshot. Replaces the on-screen Energy table
  -- (UI only — the existing inverter_5min table and energy_5min stay
  -- untouched). One row per (inverter_ip, slave, date_local, slot_index).
  -- slot_index = (hour*60 + minute) / 5  (0..287)
  -- in_solar_window = 1 iff hour_of_slot in [solarWindowStartHour, eodSnapshotHourLocal)
  CREATE TABLE IF NOT EXISTS inverter_5min_param (
    inverter_ip       TEXT    NOT NULL,
    slave             INTEGER NOT NULL,
    date_local        TEXT    NOT NULL,
    slot_index        INTEGER NOT NULL,
    ts_ms             INTEGER NOT NULL,

    vdc_v             REAL,
    idc_a             REAL,
    pdc_w             INTEGER,

    vac1_v            REAL,
    vac2_v            REAL,
    vac3_v            REAL,

    iac1_a            REAL,
    iac2_a            REAL,
    iac3_a            REAL,

    temp_c            INTEGER,
    pac_w             INTEGER,
    cosphi            REAL,
    freq_hz           REAL,

    inv_alarms        INTEGER NOT NULL DEFAULT 0,
    track_alarms      INTEGER NOT NULL DEFAULT 0,

    sample_count      INTEGER NOT NULL DEFAULT 0,
    is_complete       INTEGER NOT NULL DEFAULT 0,
    in_solar_window   INTEGER NOT NULL DEFAULT 0,

    updated_ts        INTEGER NOT NULL
                      DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),

    PRIMARY KEY (inverter_ip, slave, date_local, slot_index)
  ) WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS idx_p5m_date     ON inverter_5min_param (date_local, inverter_ip);
  CREATE INDEX IF NOT EXISTS idx_p5m_inv_date ON inverter_5min_param (inverter_ip, slave, date_local);
  CREATE INDEX IF NOT EXISTS idx_p5m_solar    ON inverter_5min_param (date_local, in_solar_window) WHERE in_solar_window = 1;

  -- v2.11.0 Active Power Control: last successfully written %P setpoint per slave.
  -- Durable (no TTL) — state table reflects the inverter's current commanded setpoint.
  -- Replicated to remote viewers (add to replication whitelist when gateway push lands).
  CREATE TABLE IF NOT EXISTS inverter_curtailment_state (
    inverter_ip   TEXT    NOT NULL,
    slave         INTEGER NOT NULL,
    active_pct    REAL    NOT NULL DEFAULT 100,
    opcode        INTEGER NOT NULL DEFAULT 6,
    applied_ts    INTEGER NOT NULL,
    job_id        TEXT,
    source        TEXT,
    PRIMARY KEY (inverter_ip, slave)
  );

  -- v2.11.0 Active Power Control: per-write detail log for every ramp job.
  -- Retained for curtailmentRampLogRetainDays (default 90). Local-only (not replicated).
  CREATE TABLE IF NOT EXISTS inverter_curtailment_ramp_log (
    job_id        TEXT    NOT NULL,
    ts            INTEGER NOT NULL,
    inverter_ip   TEXT,
    slave         INTEGER,
    sub_step      INTEGER,
    batch_idx     INTEGER,
    setpoint_pct  REAL,
    result        TEXT,
    error         TEXT,
    PRIMARY KEY (job_id, ts, inverter_ip, slave)
  );
  CREATE INDEX IF NOT EXISTS idx_ramp_job_ts ON inverter_curtailment_ramp_log(job_id, ts);

  -- v2.11.0 IGBT Health Phase 2.1 — per-day matched-conditions thermal baseline.
  -- One row per (inverter_ip, slave, date_local). Computed by the daily capture
  -- job (23:55 local) and the startup backfill from inverter_5min_param.
  -- Pure-function math lives in server/igbtThermal.js.
  --
  -- mean_temp_c is NULL unless reason='computed'. Other reasons:
  --   'insufficient_samples' — fewer than MIN_SAMPLES (6) midday in-band rows
  --   'no_data'              — no 5-min rows for the bucket
  --   'no_rated_kw'          — ipconfig had no rated kW for the slave
  --   'excluded_stop_event'  — day contained an aging-relevant stop event
  CREATE TABLE IF NOT EXISTS igbt_thermal_baseline (
    inverter_ip    TEXT    NOT NULL,
    slave          INTEGER NOT NULL,
    date_local     TEXT    NOT NULL,
    sample_count   INTEGER NOT NULL DEFAULT 0,
    mean_temp_c    REAL,
    reason         TEXT    NOT NULL,
    computed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (inverter_ip, slave, date_local)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_igbt_thermal_date    ON igbt_thermal_baseline (date_local);
  CREATE INDEX IF NOT EXISTS idx_igbt_thermal_inv_date ON igbt_thermal_baseline (inverter_ip, slave, date_local);

  -- v2.11.x Phase 2 — Asset Health Trend Snapshots.
  -- One row per (timestamp_ms, inverter, slave).
  -- Caches computed scores and payload data to serve time-series UI charts.
  CREATE TABLE IF NOT EXISTS igbt_health_snapshot (
    timestamp_ms   INTEGER NOT NULL,
    inverter       INTEGER NOT NULL,
    slave          INTEGER NOT NULL,
    score          REAL,
    tier           TEXT,
    thermal_trips  INTEGER,
    frama_total    INTEGER,
    pi_ana_trips   INTEGER,
    temp_pe_now_c  REAL,
    imbalance_pct  REAL,
    alarm_bits     INTEGER,
    PRIMARY KEY (timestamp_ms, inverter, slave)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_igbt_health_snap_node ON igbt_health_snapshot (inverter, slave, timestamp_ms DESC);

  -- v2.11.0 Plant Controller — NGCP PGC 2016 compliance test storage.
  -- One row per test run (started → completed/aborted/failed).
  -- Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice θ.1
  CREATE TABLE IF NOT EXISTS compliance_run (
    run_id          TEXT    PRIMARY KEY,
    test_kind       TEXT    NOT NULL,             -- 't2_freq_withstand' | 't5_apc_sweep' | …
    started_at_ms   INTEGER NOT NULL,
    ended_at_ms     INTEGER,
    status          TEXT    NOT NULL DEFAULT 'running', -- running|completed|aborted|failed
    operator_actor  TEXT,                          -- bulk-auth key fingerprint or 'system'
    target_inverters TEXT,                         -- JSON array of {inverter, ip, slave}
    params_json     TEXT,                          -- JSON test parameters (sweep ramp, hold time, etc.)
    summary_json    TEXT,                          -- JSON post-run summary
    error_message   TEXT
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_compliance_run_kind_started
    ON compliance_run(test_kind, started_at_ms DESC);

  -- Per-step record (e.g. each setpoint plateau in a T5 sweep).
  CREATE TABLE IF NOT EXISTS compliance_run_step (
    run_id        TEXT    NOT NULL,
    step_idx      INTEGER NOT NULL,
    step_name     TEXT    NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms   INTEGER,
    target_value  REAL,
    achieved_value REAL,
    deviation_pct REAL,
    pass          INTEGER,                          -- 1=pass, 0=fail, NULL=indeterminate
    notes         TEXT,
    PRIMARY KEY (run_id, step_idx)
  ) WITHOUT ROWID;

  -- Time-series sample buffer (one row per capture tick per inverter).
  CREATE TABLE IF NOT EXISTS compliance_run_sample (
    run_id      TEXT    NOT NULL,
    ts_ms       INTEGER NOT NULL,
    inverter_ip TEXT    NOT NULL,
    slave       INTEGER NOT NULL,
    pac_w       INTEGER,
    qac_var     INTEGER,
    vac_avg_v   REAL,
    iac_avg_a   REAL,
    freq_hz     REAL,
    cosphi      REAL,
    temp_c      INTEGER,
    state_raw   INTEGER,
    alarm_32    INTEGER,
    pwr_red_bits INTEGER,
    PRIMARY KEY (run_id, ts_ms, inverter_ip, slave)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_compliance_sample_run_ts
    ON compliance_run_sample(run_id, ts_ms);

  -- Artifact catalog (PDF, CSV, optional witness sign-off images).
  CREATE TABLE IF NOT EXISTS compliance_run_artifact (
    run_id        TEXT    NOT NULL,
    artifact_kind TEXT    NOT NULL,                -- 'pdf' | 'csv' | 'witness'
    file_path     TEXT    NOT NULL,
    sha256        TEXT,
    bytes         INTEGER,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, artifact_kind, file_path)
  ) WITHOUT ROWID;

  -- v2.11.0 Slice δ — APC write verification log. Every cmd-3 write enqueues
  -- a verify cycle that reads holding 41006 + input 30117 bit 1; result rows
  -- live here for the APC card "Verified ✓ / Mismatch ✗" UI + audit trail.
  CREATE TABLE IF NOT EXISTS apc_verify_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    write_ts_ms     INTEGER NOT NULL,
    verify_ts_ms    INTEGER,
    inverter_ip     TEXT    NOT NULL,
    slave           INTEGER NOT NULL,
    requested_pct   REAL    NOT NULL,
    observed_q15    INTEGER,
    observed_pct    REAL,
    bit1_active     INTEGER,                       -- 1 = Modbus reduction active, 0 = not, NULL = unknown
    result          TEXT    NOT NULL,              -- 'ok' | 'mismatch' | 'no_response' | 'timeout' | 'pending'
    job_id          TEXT,
    error_message   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_apc_verify_inv_slave_ts
    ON apc_verify_log(inverter_ip, slave, write_ts_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_apc_verify_result
    ON apc_verify_log(result, write_ts_ms DESC);

  -- v2.11.x Phase 3 — Slice ζ write verification log. Every grid-control
  -- POST (phi/reactive/disable) enqueues a verify cycle that reads holding
  -- 41006-41010 and classifies. Plan: plans/2026-05-12-ppc-capabilities-implementation.md §4.
  CREATE TABLE IF NOT EXISTS grid_control_verify_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    write_ts_ms     INTEGER NOT NULL,
    verify_ts_ms    INTEGER,
    inverter_ip     TEXT    NOT NULL,
    slave           INTEGER NOT NULL,
    kind            TEXT    NOT NULL,              -- 'phi' | 'reactive' | 'disable'
    requested_raw   INTEGER,                       -- nullable for 'disable'
    observed_raw    INTEGER,
    result          TEXT    NOT NULL,              -- 'ok' | 'mismatch' | 'no_response' | 'timeout' | 'failed' | 'pending'
    operator        TEXT,
    error_message   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gc_verify_inv_slave_ts
    ON grid_control_verify_log(inverter_ip, slave, write_ts_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_gc_verify_result
    ON grid_control_verify_log(result, write_ts_ms DESC);
`);

function finalizePendingMainDbReplacementSync(database) {
  const pending = readPendingMainDbReplacement();
  if (!pending?.fileApplied) {
    return {
      applied: Number(pendingMainDbFileApplyResult?.applied || 0),
      settingsRestored: 0,
      failed: Number(pendingMainDbFileApplyResult?.failed || 0),
      pending: Number(pendingMainDbFileApplyResult?.pending || 0),
      awaitingSettingsRestore: false,
      error: String(pendingMainDbFileApplyResult?.error || ""),
    };
  }
  try {
    const rows = sanitizePreservedSettings(pending?.preservedSettings);
    if (rows.length > 0) {
      const now = Date.now();
      const upsert = database.prepare(
        `INSERT INTO settings(key,value,updated_ts) VALUES(?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value,
           updated_ts=excluded.updated_ts`,
      );
      const tx = database.transaction((entries) => {
        for (const row of entries) {
          upsert.run(row.key, row.value, now);
        }
      });
      tx(rows);
    }
    writePendingMainDbReplacement(null);
    return {
      applied: Number(pendingMainDbFileApplyResult?.applied || 0),
      settingsRestored: rows.length,
      failed: Number(pendingMainDbFileApplyResult?.failed || 0),
      pending: 0,
      awaitingSettingsRestore: false,
      error: "",
    };
  } catch (err) {
    return {
      applied: Number(pendingMainDbFileApplyResult?.applied || 0),
      settingsRestored: 0,
      failed: 1,
      pending: 1,
      awaitingSettingsRestore: true,
      error: String(err?.message || err),
    };
  }
}

function getTableColumns(database, tableName) {
  return database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
}

function isCompactReadingsShape(columns) {
  const cols = Array.isArray(columns) ? columns : [];
  return (
    cols.length === READING_STORAGE_COLUMNS.length &&
    READING_STORAGE_COLUMNS.every((name, idx) => cols[idx] === name)
  );
}

function compactReadingsTable(database) {
  const cols = getTableColumns(database, "readings");
  if (!cols.length || isCompactReadingsShape(cols)) return false;

  console.info("[DB] Compacting readings table to operational columns only.");
  const tempTable = "readings__compact_migrate";
  database.exec(`DROP TABLE IF EXISTS ${tempTable}`);
  const migrateTx = database.transaction(() => {
    database.exec(`
      CREATE TABLE ${tempTable} (
        ${READING_TABLE_DDL}
      );
      INSERT INTO ${tempTable}(id, ts, inverter, unit, pac, kwh, alarm, online)
      SELECT id, ts, inverter, unit, pac, kwh, alarm, online
        FROM readings
       ORDER BY id ASC;
      DROP TABLE readings;
      ALTER TABLE ${tempTable} RENAME TO readings;
      CREATE INDEX IF NOT EXISTS idx_r_ts ON readings(ts);
      CREATE INDEX IF NOT EXISTS idx_r_inv_ts ON readings(inverter, unit, ts);
    `);
  });
  migrateTx();
  try {
    database.exec("VACUUM");
  } catch (err) {
    console.warn("[DB] readings VACUUM skipped:", err.message);
  }
  return true;
}

function getDbStartupFootprintBytes(dbPath) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${dbPath}${suffix}`;
    try {
      if (fs.existsSync(filePath)) total += Number(fs.statSync(filePath).size || 0);
    } catch (_) {
      // Best effort only.
    }
  }
  return total;
}

function maybeCompactReadingsTableOnStartup(database, dbPath) {
  const cols = getTableColumns(database, "readings");
  if (!cols.length || isCompactReadingsShape(cols)) return false;

  const startupBytes = getDbStartupFootprintBytes(dbPath);
  if (startupBytes > STARTUP_COMPACT_MAX_BYTES) {
    console.warn(
      `[DB] Skipping startup readings compaction (${Math.round(startupBytes / (1024 * 1024))} MB footprint). ` +
        "Compact raw storage is still used for new rows; existing DB can be compacted later during maintenance.",
    );
    return false;
  }

  return compactReadingsTable(database);
}

maybeCompactReadingsTableOnStartup(db, DB_PATH);

function ensureColumn(tableName, columnName, columnDDL) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (cols.some((c) => String(c?.name || "") === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDDL}`);
}

// v2.12.x — immutable day-ahead replay inputs must identify one complete,
// originally-issued batch. Earlier builds populated this table opportunistically
// during context sync with Date.now(), which cannot establish issue-time causality.
// Those legacy rows are retained in a clearly non-causal backup table instead of
// inventing an issuance id/checksum for data whose original provenance is unknown.
function ensureForecastDayAheadImmutableSchema() {
  const desiredColumns = [
    "date",
    "issuance_id",
    "generated_ts",
    "slot",
    "time_hms",
    "kwh_inc",
    "kwh_lo",
    "kwh_hi",
    "source",
  ];
  const columns = db.prepare("PRAGMA table_info(forecast_dayahead_immutable)").all();
  const names = new Set(columns.map((column) => String(column?.name || "")));
  const primaryKey = columns
    .filter((column) => Number(column?.pk || 0) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => String(column.name));
  const schemaIsCurrent =
    desiredColumns.every((name) => names.has(name)) &&
    primaryKey.join("|") === "date|issuance_id|slot";

  if (!schemaIsCurrent) {
    const legacyRowCount = Number(
      db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead_immutable").get()?.n || 0,
    );
    const replacement = "forecast_dayahead_immutable__issuance_migrate";
    let legacyTable = "forecast_dayahead_immutable_legacy_noncausal";
    let suffix = 2;
    const tableExists = (name) => Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),
    );
    while (tableExists(legacyTable)) {
      legacyTable = `forecast_dayahead_immutable_legacy_noncausal_${suffix++}`;
    }
    db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS ${replacement};
        CREATE TABLE ${replacement} (
          date         TEXT NOT NULL,
          issuance_id  TEXT NOT NULL,
          generated_ts INTEGER NOT NULL,
          slot         INTEGER NOT NULL,
          time_hms     TEXT NOT NULL,
          kwh_inc      REAL NOT NULL,
          kwh_lo       REAL NOT NULL,
          kwh_hi       REAL NOT NULL,
          source       TEXT NOT NULL DEFAULT 'service',
          PRIMARY KEY(date, issuance_id, slot)
        );
        ALTER TABLE forecast_dayahead_immutable RENAME TO ${legacyTable};
        DROP INDEX IF EXISTS idx_fdi_date;
        DROP INDEX IF EXISTS idx_fdi_date_generated_ts;
        ALTER TABLE ${replacement} RENAME TO forecast_dayahead_immutable;
      `);
    })();
    if (legacyRowCount > 0) {
      console.warn(
        `[db] Preserved ${legacyRowCount} non-causal immutable day-ahead row(s) in ${legacyTable}; ` +
          "only new checksummed issuances are eligible for replay.",
      );
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fdi_date_generated_ts
      ON forecast_dayahead_immutable(date, generated_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_fdi_issuance_date_generated_ts
      ON forecast_dayahead_issuance(date, generated_ts DESC);
  `);
}

ensureForecastDayAheadImmutableSchema();

ensureColumn("forecast_dayahead_issuance", "constraint_snapshot_json", "constraint_snapshot_json TEXT");
ensureColumn("forecast_dayahead_issuance", "constraint_snapshot_sha256", "constraint_snapshot_sha256 TEXT");
ensureColumn("forecast_intraday_adjusted", "series_run_id", "series_run_id TEXT");
ensureColumn("forecast_intraday_run_audit", "series_run_id", "series_run_id TEXT");
ensureColumn("forecast_intraday_run_audit", "output_updated_ts", "output_updated_ts INTEGER");
ensureColumn("forecast_intraday_run_audit", "authoritative_algorithm", "authoritative_algorithm TEXT");
ensureColumn("forecast_intraday_run_audit", "challenger_status", "challenger_status TEXT");
ensureColumn("forecast_intraday_run_audit", "authoritative_write_status", "authoritative_write_status TEXT");
ensureColumn("forecast_intraday_run_audit", "configured_mode", "configured_mode TEXT");
ensureColumn("forecast_intraday_run_audit", "prior_series_preserved", "prior_series_preserved INTEGER");
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_fia_series_run_id
    ON forecast_intraday_adjusted(series_run_id);
  CREATE INDEX IF NOT EXISTS idx_fira_series_run_id
    ON forecast_intraday_run_audit(target_date, series_run_id);
`);

// Migration: ensure replication-friendly update tracking columns exist.
ensureColumn("alarms", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("daily_report", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("settings", "updated_ts", "updated_ts INTEGER NOT NULL DEFAULT 0");
// Migration: daily audit control-action count per inverter (added 2026-03).
// Migration: serial-change provenance — traces a physically relocated
// power module back to the factory slot its prior serial belonged to
// (added 2026-05-19 for the Bulk Fix relocation guard).  `origin_note` is
// the human string; `origin_inverter`/`origin_node` are the structured
// pair that powers the Power Module Migration History query (so it never
// has to text-parse the note).  `origin_node` is TEXT because it may be a
// numeric node (1..4) or the "T" nameplate.
ensureColumn("serial_change_log", "origin_note", "origin_note TEXT");
ensureColumn("serial_change_log", "origin_inverter", "origin_inverter INTEGER");
ensureColumn("serial_change_log", "origin_node", "origin_node TEXT");
ensureColumn("daily_report", "control_count", "control_count INTEGER DEFAULT 0");
ensureColumn("daily_report", "availability_pct", "availability_pct REAL DEFAULT 0");
ensureColumn("daily_report", "performance_pct", "performance_pct REAL DEFAULT 0");
ensureColumn("daily_report", "node_uptime_s", "node_uptime_s INTEGER DEFAULT 0");
ensureColumn(
  "daily_report",
  "expected_node_uptime_s",
  "expected_node_uptime_s INTEGER DEFAULT 0",
);
ensureColumn("daily_report", "expected_nodes", "expected_nodes INTEGER DEFAULT 4");
ensureColumn("daily_report", "rated_kw", "rated_kw REAL DEFAULT 0");
ensureColumn(
  "daily_readings_summary",
  "updated_ts",
  "updated_ts INTEGER NOT NULL DEFAULT 0",
);
ensureColumn(
  "daily_readings_summary",
  "last_online",
  "last_online INTEGER DEFAULT 0",
);
ensureColumn(
  "daily_readings_summary",
  "intervals_json",
  "intervals_json TEXT DEFAULT '[]'",
);
// v2.10.x — energy fast-path: incremental PAC trapezoidal integral + EOD finalization flag.
ensureColumn("daily_readings_summary", "pac_kwh_raw", "pac_kwh_raw REAL DEFAULT 0");
ensureColumn("daily_readings_summary", "last_pac_w",  "last_pac_w REAL DEFAULT 0");
ensureColumn("daily_readings_summary", "is_final",    "is_final INTEGER DEFAULT 0");
// Migration: store plant-cap decision reason in audit_log (added 2026-03).
ensureColumn("audit_log", "reason", "reason TEXT DEFAULT ''");

// v2.10.0 Slice F — link alarm rows to their captured StopReason snapshot.
// Populated when raiseActiveAlarm() triggers an auto-fetch and Python's
// /api/stop-reasons/internal/capture returns a row id. NULL for legacy alarms
// raised before v2.10.0 or for alarms whose snapshot read failed.
ensureColumn("alarms", "stop_reason_id", "stop_reason_id INTEGER");

// v2.10.x Slice ε — standard-Modbus stop-reason cross-check columns.
// Additive migrations for the inverter_stop_reasons_std table.
ensureColumn("inverter_stop_reasons_std", "motive_name", "motive_name TEXT");
ensureColumn("inverter_stop_reasons_std", "captured_at_ms", "captured_at_ms INTEGER");

// v2.11.x Slice κ.9 — "detect during solar, STOP after solar" deferral.
// `state` distinguishes a STOP-issued/write-locked block ('active') from an
// armed-but-not-yet-executed one ('pending'). Legacy rows default to 'active'
// so existing block semantics are unchanged. `armed_at_ms` + the latched
// unbalance JSON preserve the in-solar physical-confirmation evidence so the
// post-solar conversion does not need a live (and structurally unavailable)
// out-of-solar unbalance reading.
ensureColumn(
  "inverter_critical_blocks",
  "state",
  // CHECK guards against a typo'd state ever creating a "ghost" row that is
  // invisible to BOTH the state='active' and state='pending' queries (which
  // would silently neither enforce nor be ackable).
  "state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','pending'))",
);
ensureColumn("inverter_critical_blocks", "armed_at_ms", "armed_at_ms INTEGER");
ensureColumn(
  "inverter_critical_blocks",
  "unbalance_latched",
  "unbalance_latched TEXT",
);
// idx for the κ.9 state-filtered hot queries (getActive/getAllActive/
// getPending/getAllPending run on every enforcer tick + every
// /api/critical-blocks hit). The pre-κ.9 idx_icb_active does not cover
// `state`, so without this the filter degrades to a table scan as the
// acked-history grows (rows are retained indefinitely for forensics).
try {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_icb_state
       ON inverter_critical_blocks(state, acked_at_ms, inverter)`,
  );
} catch (_) { /* index is an optimisation; never fatal */ }
ensureColumn("inverter_stop_reasons_std", "source", "source TEXT NOT NULL DEFAULT 'standard_modbus'");

// v2.9.1 — EOD-clean rolling-last snapshot columns. Captured post-1800H local
// from the last PAC>0 polls; tomorrow's etotal_baseline is derived from these
// fields so a transient bad first-poll value cannot inflate today's recovered
// kWh.
ensureColumn("inverter_counter_baseline", "etotal_eod_clean", "etotal_eod_clean INTEGER");
ensureColumn("inverter_counter_baseline", "parce_eod_clean",  "parce_eod_clean INTEGER");
ensureColumn("inverter_counter_baseline", "eod_clean_ts_ms",  "eod_clean_ts_ms INTEGER");
ensureColumn("inverter_counter_baseline", "eod_clean_pac_w",  "eod_clean_pac_w INTEGER");

// v2.9.1 Phase 3 — daily totals per energy source. PAC remains in kwh_total
// (back-compat). Hardware-counter totals are NULL until end-of-day rollup
// computes them from the day's first/last counter_state ticks.
ensureColumn("daily_report", "kwh_total_etotal", "kwh_total_etotal REAL");
ensureColumn("daily_report", "kwh_total_parce",  "kwh_total_parce REAL");
// v2.10.x — parcE counter snapshot at the end of each 5-minute slot in the
// PARAMETERS view. Lifetime-monotonic kWh; row-to-row delta is the slot's
// actual energy (matches ISM "Partial Energy" semantics far more accurately
// than a PAC-integrated estimate, which has ±2% averaging error).
ensureColumn("inverter_5min_param", "parce_kwh", "parce_kwh REAL");

// v2.10.x Slice β — slow-poll diagnostic fields (additive, all NULL by default).
// Captured by services/inverter_engine.py read_slow_async (addr 64-116) every
// SLOW_POLL_INTERVAL_S (default 30 s); aggregated by server/dailyAggregator.js.
// Plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice β
// Impl: plans/slice-beta-implementation.md
ensureColumn("inverter_5min_param", "qac_var_avg",                  "qac_var_avg REAL");
ensureColumn("inverter_5min_param", "tempint_c_min",                "tempint_c_min REAL");
ensureColumn("inverter_5min_param", "tempint_c_max",                "tempint_c_max REAL");
ensureColumn("inverter_5min_param", "tempint_c_avg",                "tempint_c_avg REAL");
ensureColumn("inverter_5min_param", "zpos_kohm_min",                "zpos_kohm_min INTEGER");
ensureColumn("inverter_5min_param", "zpos_kohm_max",                "zpos_kohm_max INTEGER");
ensureColumn("inverter_5min_param", "zpos_kohm_last",               "zpos_kohm_last INTEGER");
ensureColumn("inverter_5min_param", "zneg_kohm_min",                "zneg_kohm_min INTEGER");
ensureColumn("inverter_5min_param", "zneg_kohm_max",                "zneg_kohm_max INTEGER");
ensureColumn("inverter_5min_param", "zneg_kohm_last",               "zneg_kohm_last INTEGER");
ensureColumn("inverter_5min_param", "vpv_n_v_min",                  "vpv_n_v_min INTEGER");
ensureColumn("inverter_5min_param", "vpv_n_v_max",                  "vpv_n_v_max INTEGER");
ensureColumn("inverter_5min_param", "vpv_n_v_avg",                  "vpv_n_v_avg REAL");
ensureColumn("inverter_5min_param", "vpv_p_v_min",                  "vpv_p_v_min INTEGER");
ensureColumn("inverter_5min_param", "vpv_p_v_max",                  "vpv_p_v_max INTEGER");
ensureColumn("inverter_5min_param", "vpv_p_v_avg",                  "vpv_p_v_avg REAL");
ensureColumn("inverter_5min_param", "nominal_power_w_last",         "nominal_power_w_last INTEGER");
ensureColumn("inverter_5min_param", "time_to_connect_s_min",        "time_to_connect_s_min INTEGER");
ensureColumn("inverter_5min_param", "time_to_connect_s_max",        "time_to_connect_s_max INTEGER");
ensureColumn("inverter_5min_param", "time_to_connect_s_avg",        "time_to_connect_s_avg REAL");
ensureColumn("inverter_5min_param", "time_to_connect_total_s_min",  "time_to_connect_total_s_min INTEGER");
ensureColumn("inverter_5min_param", "time_to_connect_total_s_max",  "time_to_connect_total_s_max INTEGER");
ensureColumn("inverter_5min_param", "time_to_connect_total_s_avg",  "time_to_connect_total_s_avg REAL");
ensureColumn("inverter_5min_param", "alarms_inst_32_max",           "alarms_inst_32_max INTEGER");
ensureColumn("inverter_5min_param", "alarms_maint_32_max",          "alarms_maint_32_max INTEGER");
ensureColumn("inverter_5min_param", "power_reduction_bits_last",    "power_reduction_bits_last INTEGER");
ensureColumn("inverter_5min_param", "analog_in_1_avg",              "analog_in_1_avg REAL");
ensureColumn("inverter_5min_param", "analog_in_2_avg",              "analog_in_2_avg REAL");
ensureColumn("inverter_5min_param", "analog_in_3_avg",              "analog_in_3_avg REAL");
ensureColumn("inverter_5min_param", "analog_in_4_avg",              "analog_in_4_avg REAL");
ensureColumn("inverter_5min_param", "pt100_1_last",                 "pt100_1_last INTEGER");
ensureColumn("inverter_5min_param", "pt100_2_last",                 "pt100_2_last INTEGER");
ensureColumn("inverter_5min_param", "inverter_state_raw_last",      "inverter_state_raw_last INTEGER");

// v2.11.x Slice κ — grid-connection cycle counters (K1 contactor wear).
// Captured from fast-poll input regs 30005-30006 (lifetime, UInt32 hi-lo)
// and 30063-30064 (resettable variant). Both already inside the 0-77
// fast-read range — zero extra Modbus traffic.
//
// Stored as the LAST-known snapshot per 5-min slot (monotonic counters).
// The contactor health module derives Δ-cycles/day per node by diffing
// today's first/last snapshot, or 30-day rolling rate. Per-slot delta is
// near-zero for healthy contactors and rises sharply when K1 chatters.
ensureColumn("inverter_5min_param", "conex_lifetime_last",   "conex_lifetime_last INTEGER");
ensureColumn("inverter_5min_param", "conex_resettable_last", "conex_resettable_last INTEGER");

// Forecast compare persistence (detailed provenance/error-memory basis).
ensureColumn("forecast_error_compare_daily", "run_audit_id", "run_audit_id INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "generator_mode", "generator_mode TEXT");
ensureColumn("forecast_error_compare_daily", "provider_expected", "provider_expected TEXT");
ensureColumn("forecast_error_compare_daily", "weather_source", "weather_source TEXT");
ensureColumn("forecast_error_compare_daily", "solcast_freshness_class", "solcast_freshness_class TEXT");
ensureColumn("forecast_error_compare_daily", "total_abs_error_kwh", "total_abs_error_kwh REAL");
ensureColumn("forecast_error_compare_daily", "daily_mape_pct", "daily_mape_pct REAL");
ensureColumn("forecast_error_compare_daily", "daily_total_ape_pct", "daily_total_ape_pct REAL");
ensureColumn("forecast_error_compare_daily", "usable_slot_count", "usable_slot_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "masked_slot_count", "masked_slot_count INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "available_actual_slots", "available_actual_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "available_forecast_slots", "available_forecast_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "manual_masked_slots", "manual_masked_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "cap_masked_slots", "cap_masked_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "operational_masked_slots", "operational_masked_slots INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "include_in_error_memory", "include_in_error_memory INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "include_in_source_scoring", "include_in_source_scoring INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "comparison_quality", "comparison_quality TEXT NOT NULL DEFAULT 'review'");
ensureColumn("forecast_error_compare_daily", "computed_ts", "computed_ts INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_daily", "notes_json", "notes_json TEXT");

// Migration: forecast confidence band totals for EMOS-B spread calibration (added 2026-03).
ensureColumn("forecast_error_compare_daily", "total_forecast_lo_kwh", "total_forecast_lo_kwh REAL");
ensureColumn("forecast_error_compare_daily", "total_forecast_hi_kwh", "total_forecast_hi_kwh REAL");
// Migration: track actual data source (metered, mixed, estimated) for error memory & loss calibration (added 2026-04).
ensureColumn("forecast_error_compare_daily", "actual_source", "actual_source TEXT DEFAULT 'estimated'");
ensureColumn("forecast_error_compare_slot", "actual_source", "actual_source TEXT DEFAULT 'estimated'");
// Migration: track retry attempt number per forecast run (added 2026-03).
ensureColumn("forecast_run_audit", "attempt_number", "attempt_number INTEGER NOT NULL DEFAULT 1");
// Migration: Solcast tri-band baseline totals for FPM pipeline (added 2026-04).
ensureColumn("forecast_run_audit", "solcast_lo_total_kwh", "solcast_lo_total_kwh REAL");
ensureColumn("forecast_run_audit", "solcast_hi_total_kwh", "solcast_hi_total_kwh REAL");
ensureColumn("forecast_run_audit", "baseline_is_solcast_mid", "baseline_is_solcast_mid INTEGER NOT NULL DEFAULT 0");
// Backfill: mark all rows as Solcast-based, backfill mid baseline, clear stale physics.
// NOTE: solcast_lo/hi_total_kwh are NOT backfilled from snapshots — tri-band P10/P90
// only exists for day-ahead (future) slots. Past dates have estimated actuals, not real bands.
try {
  // 1. Mark all rows as Solcast-based (new architecture)
  db.prepare(
    `UPDATE forecast_run_audit SET baseline_is_solcast_mid = 1 WHERE baseline_is_solcast_mid = 0`
  ).run();

  // 2. Backfill hybrid_total_kwh (Solcast mid) from snapshots for rows missing it
  const _auditRows = db.prepare(
    `SELECT DISTINCT target_date FROM forecast_run_audit WHERE hybrid_total_kwh IS NULL`
  ).all();
  if (_auditRows.length > 0) {
    const _updMid = db.prepare(`
      UPDATE forecast_run_audit
         SET hybrid_total_kwh = @mid
       WHERE target_date = @day AND hybrid_total_kwh IS NULL
    `);
    const _getSnapMid = db.prepare(`
      SELECT ROUND(SUM(forecast_kwh), 2) AS mid FROM solcast_snapshots WHERE forecast_day = ?
    `);
    let _filled = 0;
    for (const { target_date } of _auditRows) {
      const snap = _getSnapMid.get(target_date);
      if (snap && snap.mid > 0) {
        _updMid.run({ day: target_date, mid: snap.mid });
        _filled++;
      }
    }
    if (_filled > 0) console.log(`[db] Backfilled Solcast mid baseline on ${_filled} audit date(s)`);
  }

  // 3. Clear stale physics_total_kwh and incorrectly-backfilled lo/hi on historical rows
  db.prepare(
    `UPDATE forecast_run_audit SET physics_total_kwh = NULL WHERE physics_total_kwh IS NOT NULL`
  ).run();
  const _clearedLo = db.prepare(
    `UPDATE forecast_run_audit SET solcast_lo_total_kwh = NULL, solcast_hi_total_kwh = NULL
     WHERE solcast_lo_total_kwh IS NOT NULL
       AND target_date < date('now', '+1 day')`
  ).run();
  if (_clearedLo.changes > 0) console.log(`[db] Cleared historical lo/hi on ${_clearedLo.changes} audit rows (tri-band only valid for day-ahead)`);
} catch (e) { console.warn("[db] Solcast baseline backfill warning:", e.message); }
ensureColumn("forecast_error_compare_slot", "run_audit_id", "run_audit_id INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "daily_compare_id", "daily_compare_id INTEGER");
ensureColumn("forecast_error_compare_slot", "ts_local", "ts_local INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "time_hms", "time_hms TEXT NOT NULL DEFAULT ''");
ensureColumn("forecast_error_compare_slot", "solcast_kwh", "solcast_kwh REAL");
ensureColumn("forecast_error_compare_slot", "physics_kwh", "physics_kwh REAL");
ensureColumn("forecast_error_compare_slot", "hybrid_baseline_kwh", "hybrid_baseline_kwh REAL");
ensureColumn("forecast_error_compare_slot", "ml_residual_kwh", "ml_residual_kwh REAL");
ensureColumn("forecast_error_compare_slot", "error_class_bias_kwh", "error_class_bias_kwh REAL");
ensureColumn("forecast_error_compare_slot", "memory_bias_kwh", "memory_bias_kwh REAL");
ensureColumn("forecast_error_compare_slot", "signed_error_kwh", "signed_error_kwh REAL");
ensureColumn("forecast_error_compare_slot", "abs_error_kwh", "abs_error_kwh REAL");
ensureColumn("forecast_error_compare_slot", "ape_pct", "ape_pct REAL");
ensureColumn("forecast_error_compare_slot", "normalized_error", "normalized_error REAL");
ensureColumn("forecast_error_compare_slot", "opportunity_kwh", "opportunity_kwh REAL");
ensureColumn("forecast_error_compare_slot", "slot_weather_bucket", "slot_weather_bucket TEXT");
ensureColumn("forecast_error_compare_slot", "day_regime", "day_regime TEXT");
ensureColumn("forecast_error_compare_slot", "actual_present", "actual_present INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "forecast_present", "forecast_present INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "solcast_present", "solcast_present INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "usable_for_metrics", "usable_for_metrics INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "usable_for_error_memory", "usable_for_error_memory INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "manual_constraint_mask", "manual_constraint_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "cap_dispatch_mask", "cap_dispatch_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "curtailed_mask", "curtailed_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "operational_mask", "operational_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "solar_mask", "solar_mask INTEGER NOT NULL DEFAULT 0");
ensureColumn("forecast_error_compare_slot", "rad_wm2", "rad_wm2 REAL");
ensureColumn("forecast_error_compare_slot", "cloud_pct", "cloud_pct REAL");
ensureColumn("forecast_error_compare_slot", "support_weight", "support_weight REAL");

// Migration: day-ahead locked snapshot errors (v2.8+, added 2026-04).
// These capture the 10 AM locked P10/P50/P90 vs actual, letting the error
// memory system learn from what was actually submittable at submission time,
// not from "whatever Solcast said most recently".
ensureColumn("forecast_error_compare_slot", "p50_locked_mw", "p50_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "p10_locked_mw", "p10_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "p90_locked_mw", "p90_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "spread_pct_cap_locked", "spread_pct_cap_locked REAL");
ensureColumn("forecast_error_compare_slot", "err_vs_p50_locked_mw", "err_vs_p50_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "err_vs_p10_locked_mw", "err_vs_p10_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "err_vs_p90_locked_mw", "err_vs_p90_locked_mw REAL");
ensureColumn("forecast_error_compare_slot", "actual_within_band", "actual_within_band INTEGER");
// Daily roll-up of locked-snapshot accuracy (for FPM dashboard and learning-loop aggregates).
ensureColumn("forecast_error_compare_daily", "locked_captured_ts", "locked_captured_ts INTEGER");
ensureColumn("forecast_error_compare_daily", "locked_capture_reason", "locked_capture_reason TEXT");
ensureColumn("forecast_error_compare_daily", "locked_spread_pct_cap_avg", "locked_spread_pct_cap_avg REAL");
ensureColumn("forecast_error_compare_daily", "locked_total_p50_kwh", "locked_total_p50_kwh REAL");
ensureColumn("forecast_error_compare_daily", "locked_total_p10_kwh", "locked_total_p10_kwh REAL");
ensureColumn("forecast_error_compare_daily", "locked_total_p90_kwh", "locked_total_p90_kwh REAL");
ensureColumn("forecast_error_compare_daily", "locked_within_band_pct", "locked_within_band_pct REAL");

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_a_updated_ts ON alarms(updated_ts);
  -- Covers stmts.getActiveAlarmForUnit (WHERE cleared_ts IS NULL AND inverter=? AND unit=?).
  -- Keeps per-unit active-row lookup O(log N) on large historical alarm tables.
  CREATE INDEX IF NOT EXISTS idx_a_open_inv_unit ON alarms(inverter, unit, cleared_ts);
  CREATE INDEX IF NOT EXISTS idx_daily_report_updated_ts ON daily_report(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_settings_updated_ts ON settings(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_summary_date_inv ON daily_readings_summary(date, inverter, unit);
  CREATE INDEX IF NOT EXISTS idx_summary_updated_ts ON daily_readings_summary(updated_ts);
  CREATE INDEX IF NOT EXISTS idx_fra_target_authority ON forecast_run_audit(target_date, is_authoritative_runtime, generated_ts DESC);
  CREATE INDEX IF NOT EXISTS idx_fecd_target ON forecast_error_compare_daily(target_date);
  CREATE INDEX IF NOT EXISTS idx_fecd_mem_target ON forecast_error_compare_daily(include_in_error_memory, target_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fecd_target_run ON forecast_error_compare_daily(target_date, run_audit_id);
  CREATE INDEX IF NOT EXISTS idx_fecs_target_slot ON forecast_error_compare_slot(target_date, slot);
  CREATE INDEX IF NOT EXISTS idx_fecs_mem_target ON forecast_error_compare_slot(usable_for_error_memory, target_date DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fecs_target_run_slot ON forecast_error_compare_slot(target_date, run_audit_id, slot);
  CREATE INDEX IF NOT EXISTS idx_alarms_stop_reason_id ON alarms(stop_reason_id) WHERE stop_reason_id IS NOT NULL;
  -- DB-H-003: per-(inverter, unit, date_key) lookups on counter baselines.
  CREATE INDEX IF NOT EXISTS idx_icb_inv_unit_date
    ON inverter_counter_baseline(inverter, unit, date_key);
  -- DB-H-005: secondary index for bulk ops on inverter_5min_param (the table
  -- is WITHOUT ROWID with composite PK, so cleanup by (ip, slave) needs help).
  CREATE INDEX IF NOT EXISTS idx_p5m_inv_slave
    ON inverter_5min_param(inverter_ip, slave);
  -- DB-L-011: per-(inverter, unit) alarm history queries.
  CREATE INDEX IF NOT EXISTS idx_a_inv_unit_ts
    ON alarms(inverter, unit, ts DESC);
`);

const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
db.exec(`
  UPDATE alarms
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       WHEN COALESCE(cleared_ts, 0) > 0 THEN cleared_ts
       WHEN COALESCE(ts, 0) > 0 THEN ts
       ELSE ${NOW_MS_SQL}
     END;
  UPDATE daily_report
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       ELSE ${NOW_MS_SQL}
     END;
  UPDATE settings
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       ELSE ${NOW_MS_SQL}
      END;
  UPDATE daily_readings_summary
     SET updated_ts = CASE
       WHEN COALESCE(updated_ts, 0) > 0 THEN updated_ts
       ELSE ${NOW_MS_SQL}
     END,
         intervals_json = CASE
           WHEN TRIM(COALESCE(intervals_json, '')) <> '' THEN intervals_json
           ELSE '[]'
         END;
`);

// One-time consolidation of legacy duplicate open alarm rows (audit 2026-04-24,
// finding F5).  Before the v2.8.x hydration fix landed, a server restart that
// coincided with a still-active alarm could insert a second open row for the
// same (inverter, unit).  The runtime dedup in getActiveAlarms hides the
// symptom at the UI layer, but the duplicate rows still inflate per-inverter
// alarm counts and distort episode-duration export.  This migration closes
// all but the newest open row per (inverter, unit), marking the losers with
// cleared_ts=now so they stop participating in active-alarm queries.
try {
  // updated_ts is set explicitly here (not via trigger) because this block runs
  // BEFORE trg_alarms_touch_updated_ts is created below. Without the explicit
  // stamp the cloud-backup replication cursor (updated_ts ASC) would never
  // pull the consolidation to remote viewers, and they would keep the stale
  // duplicate open rows forever.
  const consolidateResult = db.prepare(`
    UPDATE alarms
       SET cleared_ts = ${NOW_MS_SQL},
           updated_ts = ${NOW_MS_SQL}
     WHERE cleared_ts IS NULL
       AND id NOT IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (PARTITION BY inverter, unit
                                     ORDER BY ts DESC, id DESC) AS rn
             FROM alarms
            WHERE cleared_ts IS NULL
         )
         WHERE rn = 1
       )
  `).run();
  if (consolidateResult?.changes > 0) {
    console.log(
      `[db] Consolidated ${consolidateResult.changes} legacy duplicate open alarm row(s) — kept newest per (inverter, unit)`,
    );
  }
} catch (e) {
  console.warn("[db] Alarm duplicate consolidation warning:", e.message);
}

db.exec(`
  CREATE TRIGGER IF NOT EXISTS trg_alarms_touch_updated_ts
  AFTER UPDATE ON alarms
  FOR EACH ROW
  WHEN NEW.updated_ts = OLD.updated_ts
  BEGIN
    UPDATE alarms SET updated_ts = ${NOW_MS_SQL} WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_alarms_insert_updated_ts
  AFTER INSERT ON alarms
  FOR EACH ROW
  WHEN COALESCE(NEW.updated_ts, 0) = 0
  BEGIN
    UPDATE alarms SET updated_ts = ${NOW_MS_SQL} WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_daily_report_touch_updated_ts
  AFTER UPDATE ON daily_report
  FOR EACH ROW
  WHEN NEW.updated_ts = OLD.updated_ts
  BEGIN
    UPDATE daily_report SET updated_ts = ${NOW_MS_SQL} WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_summary_touch_updated_ts
  AFTER UPDATE ON daily_readings_summary
  FOR EACH ROW
  WHEN NEW.updated_ts = OLD.updated_ts
  BEGIN
    UPDATE daily_readings_summary
       SET updated_ts = ${NOW_MS_SQL}
     WHERE date = NEW.date AND inverter = NEW.inverter AND unit = NEW.unit;
  END;
`);

const pendingMainDbFinalizeResult = finalizePendingMainDbReplacementSync(db);
if (Number(pendingMainDbFinalizeResult?.applied || 0) > 0) {
  console.log("[DB] Applied staged main DB replacement on startup.");
}
if (Number(pendingMainDbFinalizeResult?.settingsRestored || 0) > 0) {
  console.log(
    `[DB] Restored ${Number(pendingMainDbFinalizeResult.settingsRestored || 0)} preserved local setting(s) after main DB replacement.`,
  );
}
if (Number(pendingMainDbFinalizeResult?.failed || 0) > 0) {
  console.warn(
    "[DB] Staged main DB replacement is still pending:",
    String(pendingMainDbFinalizeResult?.error || "unknown error"),
  );
}

// One-shot repair for the v2.10.0-beta.1..4 dailyAggregator double-scale bug.
// Every row in inverter_5min_param written before the 2026-04-28 fix has
// pac_w stored 10× too high (parseRow already converted deca-W → W, then the
// aggregator re-multiplied by 10). The settings flag makes this idempotent —
// once `pac_w_decascale_repaired` is set, subsequent boots skip the UPDATE
// even if the operator restores from a partially-repaired backup. See
// audits/2026-04-28/pac-w-decascale-fix.md for the full forensic trail.
try {
  const flagRow = db.prepare(`SELECT value FROM settings WHERE key = 'pac_w_decascale_repaired'`).get();
  if (flagRow?.value !== "1") {
    const result = db.prepare(`
      UPDATE inverter_5min_param
         SET pac_w = CAST(ROUND(pac_w / 10.0) AS INTEGER)
       WHERE pac_w IS NOT NULL AND pac_w > 0
    `).run();
    db.prepare(`
      INSERT INTO settings(key, value, updated_ts) VALUES('pac_w_decascale_repaired', '1', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts
    `).run(Date.now());
    try {
      db.prepare(`
        INSERT INTO audit_log(ts, operator, inverter, node, action, scope, result, reason)
        VALUES (?, 'SYSTEM', 0, 0, 'pac_w_decascale_repair', 'global', 'ok', ?)
      `).run(
        Date.now(),
        `Repaired ${result.changes} rows in inverter_5min_param: pac_w / 10 (post-v2.10.0-beta.4 dailyAggregator scale fix; bug was double ×10 from poller.parseRow + aggregator)`,
      );
    } catch (_) { /* audit_log may not be ready on first-ever boot */ }
    console.log(`[pac_w_repair] repaired ${result.changes} rows in inverter_5min_param (one-shot)`);
  }
} catch (err) {
  console.warn("[pac_w_repair] migration failed:", err?.message || err);
}

const stmts = {
  insertReading: db.prepare(`
    INSERT INTO readings (ts,inverter,unit,pac,kwh,alarm,online)
    VALUES (@ts,@inverter,@unit,@pac,@kwh,@alarm,@online)
  `),
  insertAlarm: db.prepare(`
    INSERT INTO alarms (ts,inverter,unit,alarm_code,alarm_value,severity,updated_ts)
    VALUES (@ts,@inverter,@unit,@alarm_code,@alarm_value,@severity,@updated_ts)
  `),
  // updated_ts is bumped on every in-place combination change so the moment
  // the alarm bitmask changed is recoverable (2.1 — consistent timestamping).
  updateActiveAlarm: db.prepare(
    `UPDATE alarms
       SET alarm_code=?,
           alarm_value=?,
           severity=?,
           updated_ts=?
     WHERE inverter=? AND unit=? AND cleared_ts IS NULL`,
  ),
  clearAlarm: db.prepare(
    `UPDATE alarms SET cleared_ts=? WHERE inverter=? AND unit=? AND cleared_ts IS NULL`,
  ),
  getMaxAlarmUpdatedTs: db.prepare(
    `SELECT COALESCE(MAX(updated_ts), 0) AS updated_ts FROM alarms`,
  ),
  // ACK mutations carry an explicit, monotonically increasing replication
  // timestamp.  The generic UPDATE trigger remains a safety net, while this
  // stamp guarantees an ACK cannot share the remote cursor's millisecond and
  // disappear from a later incremental gateway/standby merge.
  ackAlarm: db.prepare(
    `UPDATE alarms
        SET acknowledged=1, updated_ts=?
      WHERE id=? AND acknowledged=0`,
  ),
  // Keep semantics aligned with per-row ACK: acknowledge every unacked alarm row.
  ackAllAlarms: db.prepare(
    `UPDATE alarms SET acknowledged=1, updated_ts=? WHERE acknowledged=0`,
  ),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key=?`),
  setSetting: db.prepare(
    `INSERT INTO settings(key,value,updated_ts) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       updated_ts=excluded.updated_ts`,
  ),
  insertEnergy5: db.prepare(
    `INSERT INTO energy_5min(ts,inverter,kwh_inc) VALUES(?,?,?)`,
  ),
  upsertAvailability5min: db.prepare(
    `INSERT INTO availability_5min(ts, online_count, expected_count) VALUES(?, ?, ?)
     ON CONFLICT(ts) DO UPDATE SET online_count=excluded.online_count, expected_count=excluded.expected_count`,
  ),
  getAvailability5minRange: db.prepare(
    `SELECT ts, online_count, expected_count FROM availability_5min WHERE ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  getActiveAlarms: db.prepare(
    `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
       FROM alarms WHERE cleared_ts IS NULL ORDER BY ts DESC LIMIT 5000`,
  ),
  // T2.5 fix (Phase 5, 2026-04-14): fetch the still-active alarm row for a
  // single (inverter, unit), if any.  Used on first batch after restart to
  // avoid inserting a duplicate active row when the in-memory tracker has
  // not yet been hydrated from DB state.
  getActiveAlarmForUnit: db.prepare(
    `SELECT id, alarm_code, alarm_value, severity, ts FROM alarms
      WHERE cleared_ts IS NULL AND inverter = ? AND unit = ?
      ORDER BY ts DESC LIMIT 1`,
  ),
  getAlarmsRange: db.prepare(
    `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
       FROM alarms WHERE ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000`,
  ),
  getReadingsRange: db.prepare(
    `SELECT ${READING_SELECT_SQL} FROM readings WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  getReadingsRangeAll: db.prepare(
    `SELECT ${READING_SELECT_SQL} FROM readings WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, unit ASC, ts ASC`,
  ),
  get5minRange: db.prepare(
    `SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
  ),
  get5minRangeAll: db.prepare(
    `SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter, ts ASC`,
  ),
  countReadingsRange: db.prepare(
    `SELECT COUNT(*) AS n FROM readings WHERE inverter=? AND ts BETWEEN ? AND ?`,
  ),
  countReadingsRangeAll: db.prepare(
    `SELECT COUNT(*) AS n FROM readings WHERE ts BETWEEN ? AND ?`,
  ),
  countEnergy5minRangeAll: db.prepare(
    `SELECT COUNT(*) AS n FROM energy_5min WHERE ts BETWEEN ? AND ?`,
  ),
  // Half-open [s,e) distinct 5-min (or arbitrary slot) bucket ids — hot side
  // of the archive-aware countDistinctReadingBuckets() helper. SQL-side
  // DISTINCT keeps memory bounded to the bucket count, not the raw row count.
  selectReadingBucketsRange: db.prepare(
    `SELECT DISTINCT (ts / ?) AS b FROM readings WHERE ts >= ? AND ts < ?`,
  ),
  selectMaxReadingTs: db.prepare(`SELECT MAX(ts) AS m FROM readings`),
  sumEnergy5minRange: db.prepare(
    `SELECT inverter, SUM(kwh_inc) AS total_kwh
       FROM energy_5min
      WHERE ts BETWEEN ? AND ?
      GROUP BY inverter
      ORDER BY inverter ASC`,
  ),
  sumEnergy5minRangeByInv: db.prepare(
    `SELECT inverter, SUM(kwh_inc) AS total_kwh
       FROM energy_5min
      WHERE inverter=? AND ts BETWEEN ? AND ?
      GROUP BY inverter`,
  ),
  upsertDailyReport: db.prepare(`
    INSERT INTO daily_report(
      date,inverter,kwh_total,pac_peak,pac_avg,uptime_s,alarm_count,control_count,
      availability_pct,performance_pct,node_uptime_s,expected_node_uptime_s,expected_nodes,rated_kw,
      kwh_total_etotal,kwh_total_parce,updated_ts
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
    ON CONFLICT(date,inverter) DO UPDATE SET
      kwh_total=excluded.kwh_total,
      pac_peak=excluded.pac_peak,
      pac_avg=excluded.pac_avg,
      uptime_s=excluded.uptime_s,
      alarm_count=excluded.alarm_count,
      control_count=excluded.control_count,
      availability_pct=excluded.availability_pct,
      performance_pct=excluded.performance_pct,
      node_uptime_s=excluded.node_uptime_s,
      expected_node_uptime_s=excluded.expected_node_uptime_s,
      expected_nodes=excluded.expected_nodes,
      rated_kw=excluded.rated_kw,
      kwh_total_etotal=excluded.kwh_total_etotal,
      kwh_total_parce=excluded.kwh_total_parce,
      updated_ts=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  `),
  getDailyReport: db.prepare(
    `SELECT * FROM daily_report WHERE date=? ORDER BY inverter`,
  ),
  getDailyReportRange: db.prepare(
    `SELECT * FROM daily_report WHERE date BETWEEN ? AND ? ORDER BY date, inverter`,
  ),
  getDailyReadingsSummaryOne: db.prepare(
    `SELECT * FROM daily_readings_summary WHERE date=? AND inverter=? AND unit=?`,
  ),
  getDailyReadingsSummaryDay: db.prepare(
    `SELECT * FROM daily_readings_summary WHERE date=? ORDER BY inverter ASC, unit ASC`,
  ),
  deleteDailyReadingsSummaryDay: db.prepare(
    `DELETE FROM daily_readings_summary WHERE date=?`,
  ),
  // v2.10.x — fetch finalized rows for the export fast-path.
  getFinalizedDailySummaryRange: db.prepare(
    `SELECT * FROM daily_readings_summary WHERE date BETWEEN ? AND ? AND is_final=1 ORDER BY date, inverter ASC, unit ASC`,
  ),
  // v2.11.x — fetch ALL rows in range (live + finalized) for the running-MWh
  // fast-path that lets today's slice avoid a full raw-readings scan. Each row
  // already carries pac_kwh_raw maintained incrementally by
  // applyReadingToSummaryState() on every persisted reading, so this query is
  // a cheap O(rows-in-range) lookup that replaces the slow-path scan.
  getDailyRunningSummaryRange: db.prepare(
    `SELECT * FROM daily_readings_summary WHERE date BETWEEN ? AND ? ORDER BY date, inverter ASC, unit ASC`,
  ),
  upsertDailyReadingsSummary: db.prepare(`
    INSERT INTO daily_readings_summary(
      date,inverter,unit,sample_count,online_samples,pac_online_sum,pac_online_count,pac_peak,
      first_ts,last_ts,first_kwh,last_kwh,last_online,intervals_json,pac_kwh_raw,last_pac_w,is_final,updated_ts
    )
    VALUES(
      @date,@inverter,@unit,@sample_count,@online_samples,@pac_online_sum,@pac_online_count,@pac_peak,
      @first_ts,@last_ts,@first_kwh,@last_kwh,@last_online,@intervals_json,@pac_kwh_raw,@last_pac_w,@is_final,@updated_ts
    )
    ON CONFLICT(date,inverter,unit) DO UPDATE SET
      sample_count=excluded.sample_count,
      online_samples=excluded.online_samples,
      pac_online_sum=excluded.pac_online_sum,
      pac_online_count=excluded.pac_online_count,
      pac_peak=excluded.pac_peak,
      first_ts=excluded.first_ts,
      last_ts=excluded.last_ts,
      first_kwh=excluded.first_kwh,
      last_kwh=excluded.last_kwh,
      last_online=excluded.last_online,
      intervals_json=excluded.intervals_json,
      pac_kwh_raw=excluded.pac_kwh_raw,
      last_pac_w=excluded.last_pac_w,
      is_final=MAX(excluded.is_final, daily_readings_summary.is_final),
      updated_ts=excluded.updated_ts
  `),
  upsertForecastDayAhead: db.prepare(`
    INSERT INTO forecast_dayahead(date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts)
    VALUES (@date, @ts, @slot, @time_hms, @kwh_inc, @kwh_lo, @kwh_hi, @source, @updated_ts)
    ON CONFLICT(date, slot) DO UPDATE SET
      ts=excluded.ts,
      time_hms=excluded.time_hms,
      kwh_inc=excluded.kwh_inc,
      kwh_lo=excluded.kwh_lo,
      kwh_hi=excluded.kwh_hi,
      source=excluded.source,
      updated_ts=excluded.updated_ts
  `),
  insertForecastDayAheadIssuance: db.prepare(`
    INSERT INTO forecast_dayahead_issuance(
      issuance_id, date, generated_ts, source, expected_slot_count,
      basis_checksum, weather_snapshot_json, weather_snapshot_sha256,
      constraint_snapshot_json, constraint_snapshot_sha256,
      model_sha256, artifact_sha256, base_run_audit_id, created_by
    ) VALUES(
      @issuance_id, @date, @generated_ts, @source, @expected_slot_count,
      @basis_checksum, @weather_snapshot_json, @weather_snapshot_sha256,
      @constraint_snapshot_json, @constraint_snapshot_sha256,
      @model_sha256, @artifact_sha256, @base_run_audit_id, @created_by
    )
  `),
  insertForecastDayAheadImmutable: db.prepare(`
    INSERT INTO forecast_dayahead_immutable(
      date, issuance_id, generated_ts, slot, time_hms,
      kwh_inc, kwh_lo, kwh_hi, source
    ) VALUES(
      @date, @issuance_id, @generated_ts, @slot, @time_hms,
      @kwh_inc, @kwh_lo, @kwh_hi, @source
    )
  `),
  upsertForecastIntradayAdjusted: db.prepare(`
    INSERT INTO forecast_intraday_adjusted(
      date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts, series_run_id
    ) VALUES(
      @date, @ts, @slot, @time_hms, @kwh_inc, @kwh_lo, @kwh_hi, @source, @updated_ts, @series_run_id
    )
    ON CONFLICT(date, slot) DO UPDATE SET
      ts=excluded.ts,
      time_hms=excluded.time_hms,
      kwh_inc=excluded.kwh_inc,
      kwh_lo=excluded.kwh_lo,
      kwh_hi=excluded.kwh_hi,
      source=excluded.source,
      updated_ts=excluded.updated_ts,
      series_run_id=excluded.series_run_id
  `),
  upsertSolcastSnapshot: db.prepare(`
    INSERT INTO solcast_snapshots(
      forecast_day, slot, ts_local, period_end_utc, period,
      forecast_mw, forecast_lo_mw, forecast_hi_mw, est_actual_mw,
      forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, est_actual_kwh,
      pulled_ts, source, updated_ts
    ) VALUES(
      @forecast_day, @slot, @ts_local, @period_end_utc, @period,
      @forecast_mw, @forecast_lo_mw, @forecast_hi_mw, @est_actual_mw,
      @forecast_kwh, @forecast_lo_kwh, @forecast_hi_kwh, @est_actual_kwh,
      @pulled_ts, @source, @updated_ts
    )
    ON CONFLICT(forecast_day, slot) DO UPDATE SET
      ts_local=excluded.ts_local,
      period_end_utc=COALESCE(excluded.period_end_utc, solcast_snapshots.period_end_utc),
      period=COALESCE(excluded.period, solcast_snapshots.period),
      -- v2.8 audit fix (R2): COALESCE the forecast_* columns. Previous behavior
      -- force-overwrote them, so a partial late-day fetch (e.g. network timeout
      -- mid-parse) could erase morning slots that were good. The est_actual_*
      -- columns already used COALESCE; this brings forecast_* in line.
      forecast_mw=COALESCE(excluded.forecast_mw, solcast_snapshots.forecast_mw),
      forecast_lo_mw=COALESCE(excluded.forecast_lo_mw, solcast_snapshots.forecast_lo_mw),
      forecast_hi_mw=COALESCE(excluded.forecast_hi_mw, solcast_snapshots.forecast_hi_mw),
      est_actual_mw=COALESCE(excluded.est_actual_mw, solcast_snapshots.est_actual_mw),
      forecast_kwh=COALESCE(excluded.forecast_kwh, solcast_snapshots.forecast_kwh),
      forecast_lo_kwh=COALESCE(excluded.forecast_lo_kwh, solcast_snapshots.forecast_lo_kwh),
      forecast_hi_kwh=COALESCE(excluded.forecast_hi_kwh, solcast_snapshots.forecast_hi_kwh),
      est_actual_kwh=COALESCE(excluded.est_actual_kwh, solcast_snapshots.est_actual_kwh),
      pulled_ts=excluded.pulled_ts,
      source=excluded.source,
      updated_ts=excluded.updated_ts
  `),
  backfillSolcastEstActual: db.prepare(`
    UPDATE solcast_snapshots
       SET est_actual_mw  = @est_actual_mw,
           est_actual_kwh = @est_actual_kwh,
           updated_ts     = @updated_ts
     WHERE forecast_day = @forecast_day
       AND slot = @slot
       AND est_actual_kwh IS NULL
  `),
  getSolcastSnapshotDay: db.prepare(
    `SELECT forecast_day, slot, ts_local, period_end_utc, period,
            forecast_mw, forecast_lo_mw, forecast_hi_mw, est_actual_mw,
            forecast_kwh, forecast_lo_kwh, forecast_hi_kwh, est_actual_kwh,
            pulled_ts, source, updated_ts
       FROM solcast_snapshots
      WHERE forecast_day = ?
      ORDER BY slot ASC`,
  ),
  // Day-ahead locked snapshot (v2.8+): INSERT OR IGNORE — first write wins.
  insertDayAheadLocked: db.prepare(`
    INSERT OR IGNORE INTO solcast_dayahead_locked(
      forecast_day, slot, ts_local, period_end_utc, period,
      p50_mw, p10_mw, p90_mw, p50_kwh, p10_kwh, p90_kwh,
      spread_mw, spread_pct_cap,
      captured_ts, captured_local, capture_reason, solcast_source, plant_cap_mw
    ) VALUES (
      @forecast_day, @slot, @ts_local, @period_end_utc, @period,
      @p50_mw, @p10_mw, @p90_mw, @p50_kwh, @p10_kwh, @p90_kwh,
      @spread_mw, @spread_pct_cap,
      @captured_ts, @captured_local, @capture_reason, @solcast_source, @plant_cap_mw
    )
  `),
  countDayAheadLocked: db.prepare(
    `SELECT COUNT(*) AS n FROM solcast_dayahead_locked WHERE forecast_day = ?`,
  ),
  getDayAheadLocked: db.prepare(
    `SELECT forecast_day, slot, ts_local, period_end_utc, period,
            p50_mw, p10_mw, p90_mw, p50_kwh, p10_kwh, p90_kwh,
            spread_mw, spread_pct_cap,
            captured_ts, captured_local, capture_reason, solcast_source, plant_cap_mw
       FROM solcast_dayahead_locked
      WHERE forecast_day = ?
      ORDER BY slot ASC`,
  ),
  getDayAheadLockedMeta: db.prepare(
    `SELECT forecast_day,
            MIN(captured_ts)   AS captured_ts,
            MIN(captured_local) AS captured_local,
            MIN(capture_reason) AS capture_reason,
            MIN(solcast_source) AS solcast_source,
            MIN(plant_cap_mw)   AS plant_cap_mw,
            AVG(spread_pct_cap) AS spread_pct_cap_avg,
            MAX(spread_pct_cap) AS spread_pct_cap_max,
            SUM(p50_kwh)        AS total_p50_kwh,
            SUM(p10_kwh)        AS total_p10_kwh,
            SUM(p90_kwh)        AS total_p90_kwh,
            COUNT(*)            AS slot_count
       FROM solcast_dayahead_locked
      WHERE forecast_day = ?`,
  ),
  // Append-only snapshot history (v2.8+): every autoFetchSolcastSnapshots() call writes here.
  insertSnapshotHistory: db.prepare(`
    INSERT OR REPLACE INTO solcast_snapshot_history(
      forecast_day, slot, captured_ts, pulled_ts,
      p50_mw, p10_mw, p90_mw, est_actual_mw, age_sec, solcast_source
    ) VALUES (
      @forecast_day, @slot, @captured_ts, @pulled_ts,
      @p50_mw, @p10_mw, @p90_mw, @est_actual_mw, @age_sec, @solcast_source
    )
  `),
  pruneSnapshotHistoryBefore: db.prepare(
    `DELETE FROM solcast_snapshot_history WHERE captured_ts < ?`,
  ),
  getSnapshotHistoryDayTrajectory: db.prepare(
    `SELECT forecast_day, slot, captured_ts, pulled_ts,
            p50_mw, p10_mw, p90_mw, est_actual_mw, age_sec, solcast_source
       FROM solcast_snapshot_history
      WHERE forecast_day = ?
      ORDER BY slot ASC, captured_ts ASC`,
  ),
  getLatestForecastRunAuditForDate: db.prepare(
    `SELECT * FROM forecast_run_audit
      WHERE target_date = ?
      ORDER BY generated_ts DESC LIMIT 1`
  ),
  getLatestAuthoritativeForecastRunAuditForDate: db.prepare(
    `SELECT * FROM forecast_run_audit
      WHERE target_date = ?
        AND run_status = 'success'
      ORDER BY is_authoritative_runtime DESC, generated_ts DESC
      LIMIT 1`
  ),
  insertForecastRunAudit: db.prepare(`
    INSERT INTO forecast_run_audit (
      target_date, generated_ts, generator_mode, provider_used, provider_expected,
      forecast_variant, weather_source, solcast_snapshot_day, solcast_snapshot_pulled_ts,
      solcast_snapshot_age_sec, solcast_snapshot_coverage_ratio, solcast_snapshot_source,
      solcast_mean_blend, solcast_reliability, solcast_primary_mode,
      solcast_raw_total_kwh, solcast_applied_total_kwh, physics_total_kwh, hybrid_total_kwh,
      final_forecast_total_kwh, ml_residual_total_kwh, error_class_total_kwh, bias_total_kwh,
      shape_skipped_for_solcast, run_status, solcast_freshness_class,
      is_authoritative_runtime, is_authoritative_learning,
      superseded_by_run_audit_id, replaces_run_audit_id, notes_json,
      solcast_lo_total_kwh, solcast_hi_total_kwh, baseline_is_solcast_mid
    ) VALUES (
      @target_date, @generated_ts, @generator_mode, @provider_used, @provider_expected,
      @forecast_variant, @weather_source, @solcast_snapshot_day, @solcast_snapshot_pulled_ts,
      @solcast_snapshot_age_sec, @solcast_snapshot_coverage_ratio, @solcast_snapshot_source,
      @solcast_mean_blend, @solcast_reliability, @solcast_primary_mode,
      @solcast_raw_total_kwh, @solcast_applied_total_kwh, @physics_total_kwh, @hybrid_total_kwh,
      @final_forecast_total_kwh, @ml_residual_total_kwh, @error_class_total_kwh, @bias_total_kwh,
      @shape_skipped_for_solcast, @run_status, @solcast_freshness_class,
      @is_authoritative_runtime, @is_authoritative_learning,
      @superseded_by_run_audit_id, @replaces_run_audit_id, @notes_json,
      @solcast_lo_total_kwh, @solcast_hi_total_kwh, @baseline_is_solcast_mid
    )
  `),
  updateForecastRunAudit: db.prepare(`
    UPDATE forecast_run_audit
       SET is_authoritative_runtime = @is_authoritative_runtime,
           is_authoritative_learning = @is_authoritative_learning,
           superseded_by_run_audit_id = @superseded_by_run_audit_id,
           replaces_run_audit_id = COALESCE(@replaces_run_audit_id, replaces_run_audit_id),
           run_status = COALESCE(@run_status, run_status),
           notes_json = @notes_json
     WHERE id = @id
  `),
  getForecastRunAuditById: db.prepare(
    `SELECT * FROM forecast_run_audit WHERE id = ? LIMIT 1`
  ),
  insertForecastErrorCompareDaily: db.prepare(`
    INSERT INTO forecast_error_compare_daily(
      target_date, run_audit_id, generator_mode,
      provider_used, provider_expected, forecast_variant, weather_source, solcast_freshness_class,
      total_forecast_kwh, total_actual_kwh, total_abs_error_kwh,
      daily_wape_pct, daily_mape_pct, daily_total_ape_pct,
      usable_slot_count, masked_slot_count,
      available_actual_slots, available_forecast_slots,
      manual_masked_slots, cap_masked_slots, operational_masked_slots,
      include_in_error_memory, include_in_source_scoring, comparison_quality,
      computed_ts, notes_json
    ) VALUES(
      @target_date, @run_audit_id, @generator_mode,
      @provider_used, @provider_expected, @forecast_variant, @weather_source, @solcast_freshness_class,
      @total_forecast_kwh, @total_actual_kwh, @total_abs_error_kwh,
      @daily_wape_pct, @daily_mape_pct, @daily_total_ape_pct,
      @usable_slot_count, @masked_slot_count,
      @available_actual_slots, @available_forecast_slots,
      @manual_masked_slots, @cap_masked_slots, @operational_masked_slots,
      @include_in_error_memory, @include_in_source_scoring, @comparison_quality,
      @computed_ts, @notes_json
    )
    ON CONFLICT(target_date, run_audit_id) DO UPDATE SET
      generator_mode=excluded.generator_mode,
      provider_used=excluded.provider_used,
      provider_expected=excluded.provider_expected,
      forecast_variant=excluded.forecast_variant,
      weather_source=excluded.weather_source,
      solcast_freshness_class=excluded.solcast_freshness_class,
      total_forecast_kwh=excluded.total_forecast_kwh,
      total_actual_kwh=excluded.total_actual_kwh,
      total_abs_error_kwh=excluded.total_abs_error_kwh,
      daily_wape_pct=excluded.daily_wape_pct,
      daily_mape_pct=excluded.daily_mape_pct,
      daily_total_ape_pct=excluded.daily_total_ape_pct,
      usable_slot_count=excluded.usable_slot_count,
      masked_slot_count=excluded.masked_slot_count,
      available_actual_slots=excluded.available_actual_slots,
      available_forecast_slots=excluded.available_forecast_slots,
      manual_masked_slots=excluded.manual_masked_slots,
      cap_masked_slots=excluded.cap_masked_slots,
      operational_masked_slots=excluded.operational_masked_slots,
      include_in_error_memory=excluded.include_in_error_memory,
      include_in_source_scoring=excluded.include_in_source_scoring,
      comparison_quality=excluded.comparison_quality,
      computed_ts=excluded.computed_ts,
      notes_json=excluded.notes_json
  `),
  insertForecastErrorCompareSlot: db.prepare(`
    INSERT INTO forecast_error_compare_slot(
      target_date, run_audit_id, daily_compare_id, slot, ts_local, time_hms,
      provider_used, forecast_kwh, actual_kwh, solcast_kwh, physics_kwh, hybrid_baseline_kwh,
      ml_residual_kwh, error_class_bias_kwh, memory_bias_kwh,
      signed_error_kwh, abs_error_kwh, ape_pct, normalized_error, opportunity_kwh,
      slot_weather_bucket, day_regime,
      actual_present, forecast_present, solcast_present,
      usable_for_metrics, usable_for_error_memory,
      manual_constraint_mask, cap_dispatch_mask, curtailed_mask, operational_mask, solar_mask,
      rad_wm2, cloud_pct, support_weight
    ) VALUES(
      @target_date, @run_audit_id, @daily_compare_id, @slot, @ts_local, @time_hms,
      @provider_used, @forecast_kwh, @actual_kwh, @solcast_kwh, @physics_kwh, @hybrid_baseline_kwh,
      @ml_residual_kwh, @error_class_bias_kwh, @memory_bias_kwh,
      @signed_error_kwh, @abs_error_kwh, @ape_pct, @normalized_error, @opportunity_kwh,
      @slot_weather_bucket, @day_regime,
      @actual_present, @forecast_present, @solcast_present,
      @usable_for_metrics, @usable_for_error_memory,
      @manual_constraint_mask, @cap_dispatch_mask, @curtailed_mask, @operational_mask, @solar_mask,
      @rad_wm2, @cloud_pct, @support_weight
    )
    ON CONFLICT(target_date, run_audit_id, slot) DO UPDATE SET
      daily_compare_id=excluded.daily_compare_id,
      ts_local=excluded.ts_local,
      time_hms=excluded.time_hms,
      provider_used=excluded.provider_used,
      forecast_kwh=excluded.forecast_kwh,
      actual_kwh=excluded.actual_kwh,
      solcast_kwh=excluded.solcast_kwh,
      physics_kwh=excluded.physics_kwh,
      hybrid_baseline_kwh=excluded.hybrid_baseline_kwh,
      ml_residual_kwh=excluded.ml_residual_kwh,
      error_class_bias_kwh=excluded.error_class_bias_kwh,
      memory_bias_kwh=excluded.memory_bias_kwh,
      signed_error_kwh=excluded.signed_error_kwh,
      abs_error_kwh=excluded.abs_error_kwh,
      ape_pct=excluded.ape_pct,
      normalized_error=excluded.normalized_error,
      opportunity_kwh=excluded.opportunity_kwh,
      slot_weather_bucket=excluded.slot_weather_bucket,
      day_regime=excluded.day_regime,
      actual_present=excluded.actual_present,
      forecast_present=excluded.forecast_present,
      solcast_present=excluded.solcast_present,
      usable_for_metrics=excluded.usable_for_metrics,
      usable_for_error_memory=excluded.usable_for_error_memory,
      manual_constraint_mask=excluded.manual_constraint_mask,
      cap_dispatch_mask=excluded.cap_dispatch_mask,
      curtailed_mask=excluded.curtailed_mask,
      operational_mask=excluded.operational_mask,
      solar_mask=excluded.solar_mask,
      rad_wm2=excluded.rad_wm2,
      cloud_pct=excluded.cloud_pct,
      support_weight=excluded.support_weight
  `),
  getForecastErrorCompareSlotsForDays: db.prepare(`
    SELECT target_date, run_audit_id, slot, provider_used,
           forecast_kwh, actual_kwh, signed_error_kwh, abs_error_kwh,
           usable_for_error_memory, support_weight
      FROM forecast_error_compare_slot
     WHERE target_date IN (SELECT value FROM json_each(?))
     ORDER BY target_date ASC, run_audit_id ASC, slot ASC
  `),
  deleteForecastDayAheadDate: db.prepare(
    `DELETE FROM forecast_dayahead WHERE date=?`,
  ),
  deleteForecastIntradayAdjustedDate: db.prepare(
    `DELETE FROM forecast_intraday_adjusted WHERE date=?`,
  ),
  getForecastDayAheadDate: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_dayahead
     WHERE date=?
     ORDER BY ts ASC`,
  ),
  getForecastIntradayAdjustedDate: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts, series_run_id
     FROM forecast_intraday_adjusted
     WHERE date=?
     ORDER BY ts ASC`,
  ),
  getForecastDayAheadRange: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
     FROM forecast_dayahead
     WHERE ts BETWEEN ? AND ?
     ORDER BY ts ASC`,
  ),
  getForecastIntradayAdjustedRange: db.prepare(
    `SELECT date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts, series_run_id
     FROM forecast_intraday_adjusted
     WHERE ts BETWEEN ? AND ?
     ORDER BY ts ASC`,
  ),
  getLatestForecastIntradayRunAuditForDate: db.prepare(
    `SELECT * FROM forecast_intraday_run_audit
      WHERE target_date=?
      ORDER BY generated_ts DESC LIMIT 1`,
  ),
  getForecastIntradayRunAuditBySeriesRunId: db.prepare(
    `SELECT * FROM forecast_intraday_run_audit
      WHERE target_date=? AND series_run_id=? AND authoritative_write_status='success'
      ORDER BY generated_ts DESC LIMIT 1`,
  ),
  pruneForecastIntradayRunAuditBeforeTs: db.prepare(
    `DELETE FROM forecast_intraday_run_audit WHERE generated_ts < ?`,
  ),
  insertChatMessage: db.prepare(`
    INSERT INTO chat_messages (ts, from_machine, to_machine, from_name, message, read_ts)
    VALUES (@ts, @from_machine, @to_machine, @from_name, @message, @read_ts)
  `),
  getChatMessageById: db.prepare(
    `SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
       FROM chat_messages
      WHERE id=?`,
  ),
  getChatThread: db.prepare(
    `SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
       FROM (
         SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
           FROM chat_messages
          ORDER BY id DESC
          LIMIT ?
       )
      ORDER BY id ASC`,
  ),
  getChatInboxAfterId: db.prepare(
    `SELECT id, ts, from_machine, to_machine, from_name, message, read_ts
       FROM chat_messages
      WHERE to_machine=? AND id>?
      ORDER BY id ASC
      LIMIT ?`,
  ),
  getLatestChatInboundId: db.prepare(
    `SELECT COALESCE(MAX(id), 0) AS id
       FROM chat_messages
      WHERE to_machine=?`,
  ),
  markChatReadUpToId: db.prepare(
    `UPDATE chat_messages
        SET read_ts=?
      WHERE to_machine=?
        AND id<=?
        AND read_ts IS NULL`,
  ),
  clearChatMessages: db.prepare(`DELETE FROM chat_messages`),
  purgeChatOverflow: db.prepare(
    `DELETE FROM chat_messages
      WHERE id<=COALESCE((
        SELECT id
          FROM chat_messages
         ORDER BY id DESC
         LIMIT 1 OFFSET ?
      ), 0)`,
  ),
  // v2.9.0 Slice B — hardware counter persistence
  upsertCounterState: db.prepare(
    `INSERT INTO inverter_counter_state
       (inverter, unit, ts_ms, etotal_kwh, parce_kwh,
        rtc_ms, rtc_valid, rtc_drift_s, pac_w, fac_hz, alarm_32,
        counter_advancing, updated_ts)
     VALUES
       (@inverter, @unit, @ts_ms, @etotal_kwh, @parce_kwh,
        @rtc_ms, @rtc_valid, @rtc_drift_s, @pac_w, @fac_hz, @alarm_32,
        @counter_advancing, @now)
     ON CONFLICT(inverter, unit) DO UPDATE SET
       ts_ms             = excluded.ts_ms,
       etotal_kwh        = excluded.etotal_kwh,
       parce_kwh         = excluded.parce_kwh,
       rtc_ms            = excluded.rtc_ms,
       rtc_valid         = excluded.rtc_valid,
       rtc_drift_s       = excluded.rtc_drift_s,
       pac_w             = excluded.pac_w,
       fac_hz            = excluded.fac_hz,
       alarm_32          = excluded.alarm_32,
       counter_advancing = excluded.counter_advancing,
       updated_ts        = excluded.updated_ts`,
  ),
  selectCounterStateOne: db.prepare(
    `SELECT inverter, unit, ts_ms, etotal_kwh, parce_kwh,
            rtc_ms, rtc_valid, rtc_drift_s, pac_w, fac_hz, alarm_32,
            counter_advancing
       FROM inverter_counter_state
      WHERE inverter=? AND unit=?`,
  ),
  selectCounterStateAll: db.prepare(
    `SELECT inverter, unit, ts_ms, etotal_kwh, parce_kwh,
            rtc_ms, rtc_valid, rtc_drift_s, pac_w, fac_hz, alarm_32,
            counter_advancing
       FROM inverter_counter_state
      ORDER BY inverter, unit`,
  ),
  insertBaseline: db.prepare(
    `INSERT OR IGNORE INTO inverter_counter_baseline
       (inverter, unit, date_key, etotal_baseline, parce_baseline,
        baseline_ts_ms, source, updated_ts)
     VALUES
       (@inverter, @unit, @date_key, @etotal_baseline, @parce_baseline,
        @baseline_ts_ms, @source, @now)`,
  ),
  selectBaselineOne: db.prepare(
    `SELECT etotal_baseline, parce_baseline, baseline_ts_ms, source,
            etotal_eod_clean, parce_eod_clean, eod_clean_ts_ms, eod_clean_pac_w
       FROM inverter_counter_baseline
      WHERE inverter=? AND unit=? AND date_key=?`,
  ),
  selectBaselinesForDate: db.prepare(
    `SELECT inverter, unit, etotal_baseline, parce_baseline,
            baseline_ts_ms, source,
            etotal_eod_clean, parce_eod_clean, eod_clean_ts_ms, eod_clean_pac_w
       FROM inverter_counter_baseline
      WHERE date_key=?
      ORDER BY inverter, unit`,
  ),
  // v2.10.x — INSERT-or-UPDATE for the dark-window clean snapshot.
  //
  // Earlier versions used an UPDATE-only statement that silently affected
  // 0 rows when the target day's row didn't exist. That left a hole in
  // the trust ladder: a gateway that booted post-midnight (or had been
  // off all of yesterday's dark window) never wrote yesterday's row, so
  // today's first poll fell back to source='poll' with no path to
  // recover. The new UPSERT creates the row when missing using `source =
  // 'eod_clean_only'` to signal "morning baseline unknown — this row's
  // own Δ is unrecoverable, but it can still anchor TOMORROW".
  //
  // The export path (server/hwCounterDeltaCore.js) explicitly NaN-
  // propagates `eod_clean_only` rows so the day-total HW columns blank
  // out instead of silently reporting 0 kWh.
  upsertEodClean: db.prepare(
    `INSERT INTO inverter_counter_baseline
       (inverter, unit, date_key,
        etotal_baseline, parce_baseline, baseline_ts_ms, source,
        etotal_eod_clean, parce_eod_clean,
        eod_clean_ts_ms, eod_clean_pac_w,
        updated_ts)
     VALUES
       (@inverter, @unit, @date_key,
        @etotal_eod_clean, @parce_eod_clean, @eod_clean_ts_ms, 'eod_clean_only',
        @etotal_eod_clean, @parce_eod_clean,
        @eod_clean_ts_ms, @eod_clean_pac_w,
        @now)
     ON CONFLICT (inverter, unit, date_key) DO UPDATE SET
        etotal_eod_clean = excluded.etotal_eod_clean,
        parce_eod_clean  = excluded.parce_eod_clean,
        eod_clean_ts_ms  = excluded.eod_clean_ts_ms,
        eod_clean_pac_w  = excluded.eod_clean_pac_w,
        updated_ts       = excluded.updated_ts`,
  ),
  // v2.10.x — Retroactive upgrade: rewrite today's `source='poll'` row to
  // `source='eod_clean'` once yesterday's clean close becomes available.
  // Anchors today's Etotal Δ to yesterday's actual close instead of the
  // first-poll-of-the-day value (which under-reports today's energy by
  // whatever the inverter produced before the gateway's first poll).
  upgradeBaselineToEodClean: db.prepare(
    `UPDATE inverter_counter_baseline
        SET etotal_baseline = @etotal_baseline,
            parce_baseline  = @parce_baseline,
            baseline_ts_ms  = @baseline_ts_ms,
            source          = 'eod_clean',
            updated_ts      = @now
      WHERE inverter=@inverter AND unit=@unit AND date_key=@date_key
        AND source = 'poll'`,
  ),
  selectBaselineEodClean: db.prepare(
    `SELECT inverter, unit, date_key, etotal_eod_clean, parce_eod_clean,
            eod_clean_ts_ms, eod_clean_pac_w
       FROM inverter_counter_baseline
      WHERE date_key=?`,
  ),
  insertClockSyncLog: db.prepare(
    `INSERT INTO inverter_clock_sync_log
       (ts, inverter, unit, trigger, target_iso,
        drift_before_s, drift_after_s, accepted, error)
     VALUES
       (@ts, @inverter, @unit, @trigger, @target_iso,
        @drift_before_s, @drift_after_s, @accepted, @error)`,
  ),
  selectClockSyncLog: db.prepare(
    `SELECT id, ts, inverter, unit, trigger, target_iso,
            drift_before_s, drift_after_s, accepted, error
       FROM inverter_clock_sync_log
      ORDER BY ts DESC
      LIMIT ?`,
  ),
};

const bulkInsert = db.transaction((rows) => {
  for (const row of rows) {
    try {
      stmts.insertReading.run(row);
    } catch (err) {
      console.error("[DB] bulkInsert row failed:", err.message, row);
    }
  }
});

// Combined transaction: insert readings + update daily summary in one commit.
// Halves fsync cost compared to running bulkInsert then ingestDailyReadingsSummary separately.
const bulkInsertWithSummary = db.transaction((rows) => {
  for (const row of rows) {
    try {
      stmts.insertReading.run(row);
    } catch (err) {
      console.error("[DB] bulkInsertWithSummary row failed:", err.message, row);
    }
  }
  // Inline the summary ingestion within the same transaction.
  const states = new Map();
  for (const row of rows) {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(ts > 0) || !(inverter > 0) || !(unit > 0)) continue;
    const day = localDateStr(ts);
    const key = `${day}|${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      const existing = stmts.getDailyReadingsSummaryOne.get(day, inverter, unit);
      state = createSummaryState(day, inverter, unit, existing);
      states.set(key, state);
    }
    applyReadingToSummaryState(state, row);
  }
  if (states.size) {
    const now = Date.now();
    const payloads = Array.from(states.values()).map((s) => summaryStateToPayload(s, now));
    for (const payload of payloads) {
      stmts.upsertDailyReadingsSummary.run(payload);
    }
  }
});

// v2.9.0 Slice B/F — in-memory counter history for counter_advancing gate.
// Keyed by `${inverter}_${unit}`; list of {ts_ms, etotal_kwh, parce_kwh, pac_w}.
// Bounded by COUNTER_HISTORY_MAX_SAMPLES per key (default 30 ≈ 5 minutes @10s).
const COUNTER_HISTORY_MAX_SAMPLES = 30;
const counterHistory = new Map();

function _pushCounterHistory(inverter, unit, sample) {
  const key = `${inverter}_${unit}`;
  const arr = counterHistory.get(key) || [];
  arr.push(sample);
  while (arr.length > COUNTER_HISTORY_MAX_SAMPLES) arr.shift();
  counterHistory.set(key, arr);
  return arr;
}

function getCounterHistory(inverter, unit) {
  return counterHistory.get(`${inverter}_${unit}`) || [];
}

function evaluateCounterAdvancing(history, pacIdleW = 500, windowS = 300) {
  if (!history || history.length < 2) return 1; // insufficient data → assume OK
  const latestMs = history[history.length - 1].ts_ms || 0;
  const cutoff = latestMs - windowS * 1000;
  const recent = history.filter((r) => (r.ts_ms || 0) >= cutoff);
  if (recent.length < 2) return 1;
  const meanPac =
    recent.reduce((s, r) => s + Number(r.pac_w || 0), 0) / recent.length;
  if (meanPac < pacIdleW) return 1; // idle — no expected counter tick
  for (let i = 1; i < recent.length; i++) {
    if (Number(recent[i].etotal_kwh || 0) > Number(recent[i - 1].etotal_kwh || 0)) {
      return 1;
    }
  }
  return 0;
}

// v2.11.x — Counter-health audit emitter (1-hr per-unit dedup).
// Run from persistCounterState. Produces audit_log rows for two operator-
// facing failure modes: counter regression and stuck counter. Dedup is
// per (inverter, unit, action) so each anomaly logs at most once per hour
// even under a sustained issue. Implementation lives in the same file as
// persistCounterState so it shares the in-memory `counterHistory` Map and
// doesn't need a fresh DB query per frame.
const _COUNTER_HEALTH_DEDUP_MS = 60 * 60 * 1000;
const _counterHealthLastAuditAt = new Map();   // `${inv}_${unit}_${action}` → ts ms
const _counterAdvancingPrev = new Map();        // `${inv}_${unit}` → 0|1

function _maybeAuditCounterHealth(inverter, unit, history, counterAdvancing) {
  if (!history || history.length < 2) return;
  const key = `${inverter}_${unit}`;
  const decision = decideCounterHealthAudits({
    inverter,
    unit,
    history,
    counterAdvancing,
    prevCounterAdvancing: _counterAdvancingPrev.get(key),
    lastAuditAtByKey: _counterHealthLastAuditAt,
    nowMs: Date.now(),
    dedupMs: _COUNTER_HEALTH_DEDUP_MS,
  });
  for (const a of decision.audits || []) {
    console.warn(a.consoleMessage);
    try {
      insertAuditLogRow({
        ts: Date.now(),
        operator: "SYSTEM",
        inverter, node: unit,
        action: a.action,
        scope: "single",
        result: "warn",
        reason: a.reason,
      });
    } catch (_) { /* audit log already swallows internal errors */ }
  }
  if (decision.nextCounterAdvancing !== undefined) {
    _counterAdvancingPrev.set(key, decision.nextCounterAdvancing);
  }
}

// ── Generic audit_log writer (v2.9.2) ────────────────────────────────────
//
// Used by the poller's recovery-seed/bucket spike clamps and any other
// background subsystem that needs to record a one-off event without
// duplicating the INSERT SQL. Failures are logged but never thrown — an
// audit-write failure must not break the hot poll path.
function insertAuditLogRow({
  ts,
  operator = "SYSTEM",
  inverter = 0,
  node = 0,
  action = "",
  scope = "single",
  result = "ok",
  ip = "",
  reason = "",
} = {}) {
  try {
    db.prepare(
      `INSERT INTO audit_log
         (ts, operator, inverter, node, action, scope, result, ip, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Number(ts) || Date.now(),
      String(operator),
      Math.trunc(Number(inverter) || 0),
      Math.trunc(Number(node) || 0),
      String(action),
      String(scope),
      String(result),
      String(ip),
      String(reason),
    );
    return true;
  } catch (err) {
    console.warn("[audit_log] insert failed:", err && err.message);
    return false;
  }
}

// ── eod_clean hardening helpers ──────────────────────────────────────────
//
// Verifies that yesterday's eod_clean snapshot is populated for every unit
// once we cross into the next solar window. Runs ONCE per local day (keyed
// on `todayKey`) so the audit cost is bounded regardless of poll frequency.
// Missing snapshots are surfaced in the console + an audit_log row so the
// operator can correlate "unit X shows NaN today" with "unit X did not
// capture last night" without grepping the live frames.
const _eodVerifyState = { lastVerifiedKey: "" };

// Per-(inverter, unit) "we already warned about a bad timestamp" cache so
// the log doesn't get drowned every poll cycle when one unit has clock skew.
// Cleared on local-day rollover via _eodVerifyOncePerDay.
const _eodTsWarnedKeys = new Set();

function _eodVerifyOncePerDay(todayKey, nowMs) {
  if (!todayKey || _eodVerifyState.lastVerifiedKey === todayKey) return;
  _eodVerifyState.lastVerifiedKey = todayKey;
  // New local day — purge per-unit ts-warn cache so transient skew issues
  // get re-surfaced instead of silently squelched forever.
  _eodTsWarnedKeys.clear();

  try {
    const yesterdayKey = localDateStr((Number(nowMs) || Date.now()) - 86400000);
    const rows = stmts.selectBaselinesForDate.all(yesterdayKey) || [];
    if (!rows.length) return; // no baselines for yesterday at all (fresh install / downtime)

    const missing = rows.filter((r) => {
      const ts = Number(r?.eod_clean_ts_ms || 0);
      const etot = Number(r?.etotal_eod_clean || 0);
      return ts <= 0 || etot <= 0;
    });
    if (!missing.length) return;

    const sample = missing
      .slice(0, 8)
      .map((r) => `inv${r.inverter}/u${r.unit}`)
      .join(", ");
    const more = missing.length > 8 ? `, +${missing.length - 8} more` : "";
    console.warn(
      `[counter] eod_clean MISSING on ${yesterdayKey} ` +
      `(${missing.length}/${rows.length} units): ${sample}${more}. ` +
      `Tomorrow's baseline for these units will fall back to first-frame value (source="poll"); ` +
      `Etotal/parcE today displays will show NaN until next post-1800H snapshot lands.`,
    );

    try {
      db.prepare(
        `INSERT INTO audit_log
           (ts, operator, inverter, node, action, scope, result, ip, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Number(nowMs) || Date.now(),
        "SYSTEM",
        0, // plant-wide
        0,
        "eod_clean_verify",
        `production_day=${yesterdayKey}`,
        "warn",
        "",
        `${missing.length}/${rows.length} units missing eod_clean snapshot: ` +
          missing.map((r) => `${r.inverter}/${r.unit}`).join(","),
      );
    } catch (auditErr) {
      console.warn("[counter] audit_log write failed:", auditErr.message);
    }
  } catch (err) {
    console.warn("[counter] eod_clean verify failed:", err.message);
  }
}

/**
 * v2.9.0 Slice B — persist hardware counter + RTC state for one poll frame.
 * Idempotent upsert; also records the first-of-day baseline for crash recovery.
 *
 * Frame MUST carry: inverter, unit, ts, etotal_kwh, parce_kwh,
 *                   rtc_valid, rtc_ms, rtc_drift_s, pac, fac_hz, alarm_32.
 * Fields default to zero/null when the underlying Python engine is pre-2.9.
 */
function persistCounterState(frame) {
  try {
    if (!frame) return;
    const inverter = Number(frame.inverter || 0);
    const unit = Number(frame.unit || 0);
    if (!inverter || !unit) return;

    const ts_ms = Number(frame.ts || Date.now());
    const etotal_kwh = Math.max(0, Math.trunc(Number(frame.etotal_kwh || 0)));
    const parce_kwh = Math.max(0, Math.trunc(Number(frame.parce_kwh || 0)));
    const rtc_valid = frame.rtc_valid === true || frame.rtc_valid === 1 ? 1 : 0;
    const rtc_ms_raw = Number(frame.rtc_ms);
    const rtc_ms = rtc_valid && Number.isFinite(rtc_ms_raw) ? rtc_ms_raw : null;
    const rtc_drift_s =
      rtc_valid && Number.isFinite(Number(frame.rtc_drift_s))
        ? Number(frame.rtc_drift_s)
        : null;
    // pac field in the poller row is already ×10 (W); keep as-is but clamp.
    const pac_w = Math.max(0, Math.min(Math.round(Number(frame.pac || 0)), 260_000));
    const fac_hz = Number.isFinite(Number(frame.fac_hz)) ? Number(frame.fac_hz) : null;
    const alarm_32 = Math.max(0, Math.trunc(Number(frame.alarm_32 || 0)));

    const history = _pushCounterHistory(inverter, unit, {
      ts_ms,
      etotal_kwh,
      parce_kwh,
      pac_w,
    });
    const counter_advancing = evaluateCounterAdvancing(history);

    // ── Counter health audit (v2.11.x) ──
    // Two failure modes worth catching even though the operator chose to keep
    // the aggressive 50 ms poll cadence. Both checks compare against the
    // previous in-memory sample and dedup at most once per (inv,unit) per
    // hour so the audit log doesn't flood under sustained anomalies.
    //   1. Etotal monotonicity: lifetime kWh should never decrease (the
    //      inverter accumulates it internally and it is not resettable). A
    //      drop means firmware/board swap, UInt32 counter wrap
    //      (4,294,967,295 kWh ~= 4.29 TWh — never in practice for one
    //      inverter), hardware fault, or partial frame decode. Either way
    //      the negative delta is rejected downstream by acceptDelta()
    //      (>= 0 and <= 9000 kWh/unit/day) and surfaced to the operator.
    //   2. Stuck counter: counter_advancing flipped 1→0 means the unit is
    //      producing PAC but Etotal hasn't ticked over a 5-min window —
    //      a real loss of HW counter trust until cleared.
    try {
      _maybeAuditCounterHealth(inverter, unit, history, counter_advancing);
    } catch (chErr) {
      console.warn(`[counter-health] audit failed inv=${inverter}/${unit}: ${chErr?.message || chErr}`);
    }

    const now = Date.now();
    stmts.upsertCounterState.run({
      inverter,
      unit,
      ts_ms,
      etotal_kwh,
      parce_kwh,
      rtc_ms,
      rtc_valid,
      rtc_drift_s,
      pac_w,
      fac_hz,
      alarm_32,
      counter_advancing,
      now,
    });

    // Seed today's baseline only from a trustworthy frame (RTC valid + non-zero).
    // v2.9.1 — preferred source for today's baseline is yesterday's
    // etotal_eod_clean (captured post-1800H, so identical to value-at-midnight
    // for a healthy unit). This avoids inflation when the dashboard's first
    // poll of the day lands on a transient bad read.
    //
    // v2.11.x (2026-05-11) — when no yesterday eod_clean exists AND the
    // inverter is already producing power at first observation, refuse to
    // anchor on the late poll (it would under-count today's HW Δ by the
    // morning kWh missed before boot). Decision lives in
    // baselineAnchorDecisionCore so it can be unit-tested without SQLite.
    // See audits/2026-05-11/register-decode-traceback.md for the original
    // BASELINE_LATE diagnosis.
    if (rtc_valid && etotal_kwh > 0) {
      const date_key = localDateStr(ts_ms);
      try {
        const existing = stmts.selectBaselineOne.get(inverter, unit, date_key);
        if (!existing) {
          const yesterdayKey = localDateStr(ts_ms - 86400000);
          const yPrev = stmts.selectBaselineOne.get(inverter, unit, yesterdayKey);
          const wakeW = Math.max(
            0,
            Number(getSetting("eodPacCleanThresholdW", DEFAULT_PAC_WAKE_THRESHOLD_W))
              || DEFAULT_PAC_WAKE_THRESHOLD_W,
          );
          const decision = decideBaselineAnchor({
            curEtotalKwh: etotal_kwh,
            curParceKwh:  parce_kwh,
            curTsMs:      ts_ms,
            curPacW:      pac_w,
            yesterdayEodClean: yPrev || null,
            pacWakeThresholdW: wakeW,
          });
          if (decision.source === "poll_late") {
            console.warn(
              `[counter-baseline] inv=${inverter}/${unit} day=${date_key} ` +
              `marked poll_late (${decision.reason}); HW Δ will blank for today`,
            );
          }
          stmts.insertBaseline.run({
            inverter,
            unit,
            date_key,
            etotal_baseline: decision.etotalBaseline,
            parce_baseline:  decision.parceBaseline,
            baseline_ts_ms:  decision.baselineTsMs,
            source:          decision.source,
            now,
          });
          // Refresh the live-frame compute cache so the next tick picks up
          // the new baseline.source immediately (don't wait the 60 s TTL).
          invalidateBaselineCache();
        }

        // v2.10.x — roll-last EOD-clean snapshot through the ENTIRE dark
        // window (eodSnapshotHourLocal → solarWindowStartHour, e.g.
        // 18:00–04:59 local). Etotal and parcE are MONOTONIC counters —
        // they never decrease — so the latest reading we can take before
        // the next production day starts is exactly the value we want
        // to anchor tomorrow's baseline to.
        //
        // Gate change vs v2.9.1: we now capture while `pac_w < threshold`
        // (the unit is idle, sun's down) instead of `pac_w >= threshold`.
        // The old gate only fired during the brief sunset shoulder
        // (~18:00–18:45) when the unit was still producing AND we were
        // already past EOD; if the gateway booted after sunset (e.g.
        // 21:20) every unit's snapshot was missed and the clean-anchor
        // chain stayed broken until the next clean evening.
        //
        // The new gate keeps capturing every poll all night long until
        // each unit's PAC re-emerges (sunrise). Per-unit, so units that
        // wake up at slightly different times of morning each freeze
        // their own snapshot at exactly the right moment.
        //
        // Captures past midnight (00:00–solarStart) are attributed back
        // to the PRODUCTION DAY that opened the window (yesterday's
        // date_key) so the snapshot always lives on the row of the day
        // it represents.
        const eodHour = Math.max(
          0,
          Math.min(23, Number(getSetting("eodSnapshotHourLocal", 18)) || 18),
        );
        // Setting key is preserved for back-compat; semantically it is now
        // the PAC wake threshold — capture stops once PAC climbs above it,
        // because the unit has re-entered production for the next day.
        const pacWakeThreshold = Math.max(
          0,
          Number(getSetting("eodPacCleanThresholdW", 50)) || 50,
        );
        const solarStart = Math.max(
          0,
          Math.min(23, Number(getSetting("solarWindowStartHour", 5)) || 5),
        );
        const localHour = new Date(ts_ms).getHours();
        const inDarkWindow = localHour >= eodHour || localHour < solarStart;
        const unitIsIdle = Number.isFinite(pac_w) && pac_w < pacWakeThreshold;

        // ── Timestamp accuracy guard ────────────────────────────────────
        // Reject the capture if the frame's timestamp is corrupt, in the
        // future (clock skew on the gateway), or stale beyond the polling
        // budget. Without this, a bad ts_ms could anchor eod_clean_ts_ms
        // to a value that misrepresents WHEN the snapshot was actually
        // captured, and downstream "is yesterday's snapshot fresh?" checks
        // would silently accept it.
        const TS_FUTURE_TOL_MS = 5 * 1000;          // gateway is single-host; tiny tol is enough
        const TS_STALE_TOL_MS = 5 * 60 * 1000;       // poll cycle ≪ 5 min; anything older = stale
        const TS_SANE_FLOOR = 1700000000000;         // 2023-11-14 — sanity floor against ts=0/garbage
        const tsValid =
          Number.isFinite(ts_ms) &&
          ts_ms >= TS_SANE_FLOOR &&
          ts_ms - now <= TS_FUTURE_TOL_MS &&
          now - ts_ms <= TS_STALE_TOL_MS;

        if (inDarkWindow && unitIsIdle && tsValid) {
          // Date-key normalization: a capture at 02:00 belongs to the
          // production day that ENDED last evening, not the new calendar
          // day we're sitting in. Map (00:00–solarStart) back one day.
          const productionDayKey = localHour < solarStart
            ? localDateStr(ts_ms - 86400000)
            : date_key;

          // Sanity / monotonicity / night-stability guards.
          //
          // Solar PV cannot increase Etotal at night — the unit is idle —
          // so any large positive jump during the dark window is a false
          // read (Modbus glitch, stale cached frame, register flip).
          // We accept tiny growth (≤ NIGHT_GROWTH_TOL_KWH) to absorb the
          // sunset shoulder when the gate first opens at eodSnapshotHour
          // while the unit is still trickling 50–200 W; beyond that we
          // refuse the update so the snapshot stays anchored to the most
          // recent trustworthy poll.
          //
          // Sanity ceilings keep absolute garbage out — INGECON SUN
          // counters wrap at well below 1e9 kWh in any plant we'll ever
          // run, and a parcE > etotal pair is physically impossible.
          const NIGHT_GROWTH_TOL_KWH = 5;
          const COUNTER_ABSOLUTE_MAX_KWH = 1_000_000_000; // 1 PWh ceiling

          let shouldUpdate = true;
          let regressionReason = "";

          if (!Number.isFinite(etotal_kwh) || !Number.isFinite(parce_kwh)) {
            shouldUpdate = false;
            regressionReason = `non-finite counter: etotal=${etotal_kwh} parce=${parce_kwh}`;
          } else if (etotal_kwh <= 0) {
            shouldUpdate = false;
            regressionReason = `etotal must be > 0 at night, got ${etotal_kwh}`;
          } else if (parce_kwh < 0) {
            shouldUpdate = false;
            regressionReason = `parcE negative: ${parce_kwh}`;
          } else if (etotal_kwh > COUNTER_ABSOLUTE_MAX_KWH || parce_kwh > COUNTER_ABSOLUTE_MAX_KWH) {
            shouldUpdate = false;
            regressionReason = `counter exceeds sanity ceiling`;
          } else {
            try {
              const existing = stmts.selectBaselineOne.get(
                inverter, unit, productionDayKey,
              );
              const existingEtotal = Number(existing?.etotal_eod_clean || 0);
              const existingTsMs = Number(existing?.eod_clean_ts_ms || 0);
              if (existingEtotal > 0 && existingTsMs > 0) {
                if (etotal_kwh < existingEtotal) {
                  // Regression: new < existing. Inverter rollover, bus
                  // glitch, or stale cached frame — don't poison.
                  shouldUpdate = false;
                  regressionReason = `etotal regressed ${existingEtotal}→${etotal_kwh}`;
                } else if (etotal_kwh - existingEtotal > NIGHT_GROWTH_TOL_KWH) {
                  // Night-time spike: at idle PAC the counter must not
                  // jump by more than the sunset-shoulder tolerance. A
                  // huge positive jump is a false reading.
                  shouldUpdate = false;
                  regressionReason = `night-time spike ${existingEtotal}→${etotal_kwh} (>${NIGHT_GROWTH_TOL_KWH} kWh)`;
                } else if (ts_ms < existingTsMs) {
                  // Out-of-order frame (poller backlog catching up). The
                  // existing snapshot is more recent in wall-clock terms;
                  // don't replace newer data with older.
                  shouldUpdate = false;
                  regressionReason = `frame ts older than existing snapshot ts`;
                }
              }
            } catch (_) { /* best-effort; fall through to write */ }
          }

          if (shouldUpdate) {
            stmts.upsertEodClean.run({
              inverter,
              unit,
              date_key: productionDayKey,
              etotal_eod_clean: etotal_kwh,
              parce_eod_clean:  parce_kwh,
              eod_clean_ts_ms:  ts_ms,
              eod_clean_pac_w:  pac_w,
              now,
            });

            // v2.10.x — Retroactive baseline upgrade.
            //
            // The eod_clean snapshot we just wrote may unblock today's
            // baseline: if today's row exists with `source='poll'` (e.g.
            // gateway booted post-midnight, first poll set today=poll
            // because yesterday had no eod_clean), and the row we just
            // wrote was YESTERDAY's eod_clean, rewrite today's baseline
            // to anchor on the new yesterday close.
            //
            // Pure decision lives in server/baselineUpgradeCore.js so the
            // logic can be regression-tested without spinning up SQLite.
            try {
              const todayKey = localDateStr(now);
              if (productionDayKey !== todayKey) {
                const todayRow = stmts.selectBaselineOne.get(
                  inverter, unit, todayKey,
                );
                if (todayRow && String(todayRow.source || "").toLowerCase() === "poll") {
                  const yesterdayKey = localDateStr(now - 86400000);
                  if (productionDayKey === yesterdayKey) {
                    const yPrev = stmts.selectBaselineOne.get(
                      inverter, unit, yesterdayKey,
                    );
                    const decision = baselineUpgradeCore.shouldUpgradeBaselineToEodClean({
                      todayRow,
                      yesterdayRow: yPrev,
                      currentEtotalKwh: etotal_kwh,
                    });
                    if (decision.upgrade) {
                      stmts.upgradeBaselineToEodClean.run({
                        inverter,
                        unit,
                        date_key: todayKey,
                        etotal_baseline: decision.newBaseline.etotal,
                        parce_baseline:  decision.newBaseline.parce,
                        baseline_ts_ms:  decision.newBaseline.ts_ms,
                        now,
                      });
                      invalidateBaselineCache();
                      console.log(
                        `[counter] baseline upgraded poll→eod_clean inv=${inverter} u=${unit} day=${todayKey}`,
                      );
                    }
                  }
                }
              }
            } catch (upgradeErr) {
              console.warn(
                `[counter] retroactive upgrade check failed inv=${inverter} u=${unit}: ` +
                `${upgradeErr?.message || upgradeErr}`,
              );
            }
          } else if (regressionReason) {
            console.warn(
              `[counter] eod_clean SKIPPED inv=${inverter} u=${unit} ` +
              `day=${productionDayKey} (${regressionReason})`,
            );
          }
        } else if (inDarkWindow && unitIsIdle && !tsValid) {
          // Frame met the time/PAC gate but timestamp failed sanity. Surface
          // it once-per-error so operators can chase the upstream cause.
          if (!_eodTsWarnedKeys.has(`${inverter}_${unit}`)) {
            _eodTsWarnedKeys.add(`${inverter}_${unit}`);
            console.warn(
              `[counter] eod_clean REJECTED for bad ts inv=${inverter} u=${unit} ` +
              `frame_ts=${ts_ms} now=${now} delta=${now - ts_ms}ms`,
            );
          }
        }

        // Verify-before-solar-window: once per day, at the first frame past
        // solar-window-start, audit yesterday's eod_clean coverage across
        // every baseline row. Missing snapshots are logged + recorded in
        // audit_log so an operator can correlate "unit X shows NaN today"
        // with "unit X did not capture last night".
        if (localHour >= solarStart && localHour < eodHour) {
          _eodVerifyOncePerDay(date_key, ts_ms);
        }
      } catch (err) {
        // Non-fatal: baseline seeding is best-effort.
        console.warn(
          `[counter] baseline seed failed inv=${inverter} u=${unit}: ${err.message}`,
        );
      }
    }
  } catch (err) {
    console.warn("[counter] persistCounterState error:", err.message);
  }
}

function getCounterBaselinesForDate(dateKey) {
  try {
    return stmts.selectBaselinesForDate.all(String(dateKey || ""));
  } catch {
    return [];
  }
}

// v2.9.1 — In-memory cache of today's baseline rows per (inverter, unit).
// Refreshed on local-day rollover and on demand. Used by the poller hot path
// to compute kwh_today_etotal / kwh_today_parce + validity flags without
// querying SQLite on every frame.
const _baselineCache = {
  dateKey: "",
  byKey: new Map(),     // `${inv}_${unit}` -> {etotal_baseline, parce_baseline, source}
  loadedAtMs: 0,
};
const _BASELINE_CACHE_REFRESH_MS = 60_000;

function _loadBaselineCache(dateKey) {
  try {
    const rows = stmts.selectBaselinesForDate.all(String(dateKey || "")) || [];
    const byKey = new Map();
    for (const r of rows) {
      byKey.set(`${Number(r.inverter)}_${Number(r.unit)}`, {
        etotal_baseline: Number(r.etotal_baseline || 0),
        parce_baseline:  Number(r.parce_baseline  || 0),
        source:          String(r.source || ""),
      });
    }
    _baselineCache.dateKey = dateKey;
    _baselineCache.byKey = byKey;
    _baselineCache.loadedAtMs = Date.now();
  } catch {
    // Keep stale cache rather than blanking on transient DB error.
  }
}

function getTodayBaselineCached(inverter, unit, ts = Date.now()) {
  const dateKey = localDateStr(ts);
  if (
    dateKey !== _baselineCache.dateKey ||
    Date.now() - _baselineCache.loadedAtMs > _BASELINE_CACHE_REFRESH_MS
  ) {
    _loadBaselineCache(dateKey);
  }
  return _baselineCache.byKey.get(`${Number(inverter)}_${Number(unit)}`) || null;
}

// Force a baseline-cache refresh — called when persistCounterState writes a
// new baseline row, so the poller picks up the new "source" the very next tick
// instead of waiting up to 60 s for the cache TTL.
function invalidateBaselineCache() {
  _baselineCache.loadedAtMs = 0;
}

// v2.9.1 — Per-inverter daily hardware-counter totals for daily_report writes.
// Sums each unit's (current_etotal − etotal_baseline) across the inverter, but
// only when EVERY contributing unit has a clean baseline (`source =
// "eod_clean"`). If any unit lacks a clean anchor, the inverter total is
// returned as NULL so the daily_report column stays NULL → renders as NaN in
// the UI. Mirrors the per-unit validity rule in computeTodayHardwareEnergy.
function computeInverterDailyHwTotals(inverter, dateKey, ts = Date.now()) {
  const out = { kwh_total_etotal: null, kwh_total_parce: null };
  try {
    const inv = Number(inverter || 0);
    if (!inv) return out;
    const day = String(dateKey || localDateStr(ts));
    // Pull baselines for this inverter on the requested day.
    const baselines = stmts.selectBaselinesForDate
      .all(day)
      .filter((b) => Number(b.inverter || 0) === inv);
    if (!baselines.length) return out;
    // All baselines must be eod_clean to trust the inverter's HW total.
    if (baselines.some((b) => String(b.source || "") !== "eod_clean")) return out;
    // Pull current counter state per unit; bail on any missing.
    let etotalSum = 0;
    let parceSum = 0;
    for (const b of baselines) {
      const cur = stmts.selectCounterStateOne.get(inv, Number(b.unit || 0));
      if (!cur) return { kwh_total_etotal: null, kwh_total_parce: null };
      const dE = Number(cur.etotal_kwh || 0) - Number(b.etotal_baseline || 0);
      const dP = Number(cur.parce_kwh  || 0) - Number(b.parce_baseline  || 0);
      if (!Number.isFinite(dE) || dE < 0) return { kwh_total_etotal: null, kwh_total_parce: null };
      if (!Number.isFinite(dP) || dP < 0) return { kwh_total_etotal: null, kwh_total_parce: null };
      etotalSum += dE;
      parceSum  += dP;
    }
    out.kwh_total_etotal = Number(etotalSum.toFixed(6));
    out.kwh_total_parce  = Number(parceSum.toFixed(6));
    return out;
  } catch {
    return out;
  }
}

// v2.9.1 — Compute the per-unit today-energy fields for the live frame.
// `etotal_today_valid` / `parce_today_valid` are gated on the baseline having
// been derived from yesterday's clean post-1800H snapshot (source="eod_clean").
// When invalid, the frontend renders the field literally as "NaN".
function computeTodayHardwareEnergy(frame) {
  if (!frame) return null;
  const inv = Number(frame.inverter || 0);
  const unit = Number(frame.unit || 0);
  if (!inv || !unit) return null;
  const ts = Number(frame.ts || Date.now());
  const baseline = getTodayBaselineCached(inv, unit, ts);
  const sourceClean = !!baseline && baseline.source === "eod_clean";
  const cur_etotal = Math.max(0, Number(frame.etotal_kwh || 0));
  const cur_parce  = Math.max(0, Number(frame.parce_kwh  || 0));
  const etotal_delta = baseline ? cur_etotal - Number(baseline.etotal_baseline || 0) : NaN;
  const parce_delta  = baseline ? cur_parce  - Number(baseline.parce_baseline  || 0) : NaN;
  return {
    kwh_today_etotal: sourceClean && etotal_delta >= 0 ? etotal_delta : null,
    kwh_today_parce:  sourceClean && parce_delta  >= 0 ? parce_delta  : null,
    etotal_today_valid: sourceClean && Number.isFinite(etotal_delta) && etotal_delta >= 0 ? 1 : 0,
    parce_today_valid:  sourceClean && Number.isFinite(parce_delta)  && parce_delta  >= 0 ? 1 : 0,
    baseline_source: baseline?.source || null,
  };
}

// v2.9.1 — Yesterday's clean end-of-day snapshot per unit. Sourced from
// inverter_counter_baseline.eod_clean_* which is rolled post-1800H local time
// from PAC>0 frames — independent of when the dashboard last polled. This is
// the canonical anchor for today's baseline + crash-recovery seed gate.
//
// Returned shape (for Python seed_pac_from_baseline compatibility):
//   { inverter, unit, etotal_kwh, parce_kwh, ts_ms }
//
// Units with no clean EOD snapshot for yesterday are simply omitted; the
// recovery path treats them as "no_yesterday_snapshot" and refuses to seed.
function getYesterdaySnapshotForDate(todayDateKey) {
  try {
    const key = String(todayDateKey || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return [];
    const todayStartMs = new Date(`${key}T00:00:00.000`).getTime();
    if (!Number.isFinite(todayStartMs)) return [];
    const yesterdayKey = localDateStr(todayStartMs - 86400000);
    const rows = stmts.selectBaselineEodClean.all(yesterdayKey);
    return (rows || [])
      .filter((r) => Number(r?.etotal_eod_clean || 0) > 0)
      .map((r) => ({
        inverter:    Number(r.inverter || 0),
        unit:        Number(r.unit || 0),
        etotal_kwh:  Number(r.etotal_eod_clean || 0),
        parce_kwh:   Number(r.parce_eod_clean  || 0),
        ts_ms:       Number(r.eod_clean_ts_ms  || 0),
        pac_w:       Number(r.eod_clean_pac_w  || 0),
      }));
  } catch {
    return [];
  }
}

function getCounterStateAll() {
  try {
    return stmts.selectCounterStateAll.all();
  } catch {
    return [];
  }
}

function getCounterStateOne(inverter, unit) {
  try {
    return stmts.selectCounterStateOne.get(Number(inverter || 0), Number(unit || 0)) || null;
  } catch {
    return null;
  }
}

// Coerce a drift value to a finite number or null.
// Number(null) is 0 and Number.isFinite(0) is true, so the naive check
// silently turned "no readback" into "0 second drift" in the UI.
function _coerceDrift(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function insertClockSyncLogRow(row) {
  try {
    stmts.insertClockSyncLog.run({
      ts: Number(row?.ts || Date.now()),
      inverter: Number(row?.inverter || 0),
      unit: Number(row?.unit || 0),
      trigger: String(row?.trigger || "operator"),
      target_iso: row?.target_iso ? String(row.target_iso) : null,
      drift_before_s: _coerceDrift(row?.drift_before_s),
      drift_after_s: _coerceDrift(row?.drift_after_s),
      accepted: row?.accepted ? 1 : 0,
      error: row?.error ? String(row.error) : null,
    });
  } catch (err) {
    console.warn("[clock-sync] log insert failed:", err.message);
  }
}

function getClockSyncLog(limit = 50) {
  try {
    return stmts.selectClockSyncLog.all(Math.max(1, Math.min(500, Number(limit) || 50)));
  } catch {
    return [];
  }
}

const bulkInsertPollerBatch = db.transaction((readingRows, energyRows = []) => {
  for (const row of readingRows || []) {
    try {
      stmts.insertReading.run(row);
    } catch (err) {
      console.error("[DB] bulkInsertPollerBatch reading row failed:", err.message, row);
    }
  }
  for (const row of energyRows || []) {
    try {
      stmts.insertEnergy5.run(
        Number(row?.ts || 0),
        Number(row?.inverter || 0),
        Number(row?.kwh_inc || 0),
      );
    } catch (err) {
      console.error("[DB] bulkInsertPollerBatch energy row failed:", err.message, row);
    }
  }
  const states = new Map();
  for (const row of readingRows || []) {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(ts > 0) || !(inverter > 0) || !(unit > 0)) continue;
    const day = localDateStr(ts);
    const key = `${day}|${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      const existing = stmts.getDailyReadingsSummaryOne.get(day, inverter, unit);
      state = createSummaryState(day, inverter, unit, existing);
      states.set(key, state);
    }
    applyReadingToSummaryState(state, row);
  }
  if (states.size) {
    const now = Date.now();
    const payloads = Array.from(states.values()).map((s) => summaryStateToPayload(s, now));
    for (const payload of payloads) {
      stmts.upsertDailyReadingsSummary.run(payload);
    }
  }
});

const IMMUTABLE_DAYAHEAD_START_SLOT = 60;
const IMMUTABLE_DAYAHEAD_END_SLOT = 216;

function sha256Utf8(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function canonicalForecastBasisChecksum(rows) {
  const lines = [...rows]
    .sort((a, b) => Number(a.slot) - Number(b.slot))
    .map((row) => [
      Number(row.slot),
      String(row.time_hms),
      Number(row.kwh_inc).toFixed(9),
      Number(row.kwh_lo).toFixed(9),
      Number(row.kwh_hi).toFixed(9),
    ].join("|"));
  return sha256Utf8(lines.join("\n"));
}

function validateImmutableDayAheadIssuance(day, rows, source, issuance) {
  const issuanceId = String(issuance?.issuance_id || "").trim();
  const generatedTs = Number(issuance?.generated_ts || 0);
  const expectedSlotCount = Number(issuance?.expected_slot_count);
  const basisChecksum = String(issuance?.basis_checksum || "").trim().toLowerCase();
  const issuanceDate = String(issuance?.date || day).trim();
  const requiredSlots = new Set(
    Array.from(
      { length: IMMUTABLE_DAYAHEAD_END_SLOT - IMMUTABLE_DAYAHEAD_START_SLOT },
      (_, index) => IMMUTABLE_DAYAHEAD_START_SLOT + index,
    ),
  );
  const seenSlots = new Set();
  const normalizedRows = [];

  for (const row of rows) {
    const slot = Number(row?.slot);
    const timeHms = String(row?.time_hms || "").trim();
    const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(timeHms);
    const kwhInc = Number(row?.kwh_inc);
    const kwhLo = Number(row?.kwh_lo);
    const kwhHi = Number(row?.kwh_hi);
    const timeSlot = match
      ? Math.floor((Number(match[1]) * 60 + Number(match[2])) / 5)
      : -1;
    if (
      !Number.isInteger(slot) ||
      !requiredSlots.has(slot) ||
      seenSlots.has(slot) ||
      !match || Number(match[1]) > 23 || Number(match[2]) > 59 ||
      timeSlot !== slot || Number(match[3]) !== 0 || Number(match[2]) % 5 !== 0 ||
      ![kwhInc, kwhLo, kwhHi].every(Number.isFinite) ||
      kwhLo < 0 || kwhInc < 0 || kwhHi < 0 ||
      kwhLo > kwhInc || kwhInc > kwhHi
    ) {
      throw new Error("Invalid immutable day-ahead slot batch");
    }
    seenSlots.add(slot);
    normalizedRows.push({ slot, time_hms: timeHms, kwh_inc: kwhInc, kwh_lo: kwhLo, kwh_hi: kwhHi });
  }

  const requiredCount = IMMUTABLE_DAYAHEAD_END_SLOT - IMMUTABLE_DAYAHEAD_START_SLOT;
  if (
    !issuanceId ||
    !Number.isSafeInteger(generatedTs) || generatedTs <= 0 ||
    issuanceDate !== day ||
    expectedSlotCount !== requiredCount || rows.length !== requiredCount ||
    seenSlots.size !== requiredCount ||
    !/^[a-f0-9]{64}$/.test(basisChecksum) ||
    canonicalForecastBasisChecksum(normalizedRows) !== basisChecksum
  ) {
    throw new Error("Invalid immutable day-ahead issuance metadata or checksum");
  }

  const weatherJson = issuance?.weather_snapshot_json == null
    ? null
    : String(issuance.weather_snapshot_json);
  const weatherSha = issuance?.weather_snapshot_sha256 == null
    ? null
    : String(issuance.weather_snapshot_sha256).trim().toLowerCase();
  if (!weatherJson || !/^[a-f0-9]{64}$/.test(weatherSha || "") || sha256Utf8(weatherJson) !== weatherSha) {
    throw new Error("Invalid immutable day-ahead weather snapshot checksum");
  }
  try {
    const weatherSnapshot = JSON.parse(weatherJson);
    const appliedWeatherRows = Array.isArray(weatherSnapshot?.applied_hourly)
      ? weatherSnapshot.applied_hourly
      : [];
    const weatherRows = appliedWeatherRows.length > 0
      ? appliedWeatherRows
      : weatherSnapshot?.raw_hourly;
    if (
      !weatherSnapshot || Array.isArray(weatherSnapshot) || typeof weatherSnapshot !== "object" ||
      String(weatherSnapshot.day || "") !== day ||
      !Array.isArray(weatherRows) || weatherRows.length === 0
    ) {
      throw new Error("invalid weather snapshot shape");
    }
  } catch (_) {
    throw new Error("Invalid immutable day-ahead weather snapshot payload");
  }

  const constraintJson = issuance?.constraint_snapshot_json == null
    ? null
    : String(issuance.constraint_snapshot_json);
  const constraintSha = issuance?.constraint_snapshot_sha256 == null
    ? null
    : String(issuance.constraint_snapshot_sha256).trim().toLowerCase();
  if (
    !constraintJson || !/^[a-f0-9]{64}$/.test(constraintSha || "") ||
    sha256Utf8(constraintJson) !== constraintSha
  ) {
    throw new Error("Invalid immutable day-ahead constraint snapshot checksum");
  }
  try {
    const constraints = JSON.parse(constraintJson);
    const slotCap = Number(constraints?.slot_cap_kwh);
    const blendMax = Number(constraints?.nowcast_config?.forecastIntradayBlendMax);
    const validMask = (value) => (
      Array.isArray(value) && value.length === 288 &&
      value.every((item) => item === 0 || item === 1 || item === false || item === true)
    );
    if (
      !constraints || Array.isArray(constraints) || typeof constraints !== "object" ||
      !Number.isFinite(slotCap) || slotCap <= 0 ||
      !Number.isFinite(blendMax) || blendMax < 0 || blendMax > 1 ||
      !validMask(constraints.cap_dispatch_mask) ||
      !validMask(constraints.outage_mask) ||
      normalizedRows.some((row) => Number(row.kwh_hi) > slotCap + 1e-9)
    ) {
      throw new Error("invalid constraint snapshot shape");
    }
  } catch (_) {
    throw new Error("Invalid immutable day-ahead constraint snapshot payload");
  }

  for (const field of ["model_sha256", "artifact_sha256"]) {
    const value = issuance?.[field];
    if (value != null && !/^[a-f0-9]{64}$/.test(String(value).trim().toLowerCase())) {
      throw new Error(`Invalid immutable day-ahead ${field}`);
    }
  }
  if (
    issuance?.base_run_audit_id != null &&
    (!Number.isSafeInteger(Number(issuance.base_run_audit_id)) || Number(issuance.base_run_audit_id) <= 0)
  ) {
    throw new Error("Invalid immutable day-ahead base_run_audit_id");
  }

  return {
    issuance_id: issuanceId,
    date: day,
    generated_ts: generatedTs,
    source: String(issuance?.source || source || "service"),
    expected_slot_count: requiredCount,
    basis_checksum: basisChecksum,
    weather_snapshot_json: weatherJson,
    weather_snapshot_sha256: weatherSha,
    constraint_snapshot_json: constraintJson,
    constraint_snapshot_sha256: constraintSha,
    model_sha256: issuance?.model_sha256 == null ? null : String(issuance.model_sha256).trim().toLowerCase(),
    artifact_sha256: issuance?.artifact_sha256 == null ? null : String(issuance.artifact_sha256).trim().toLowerCase(),
    base_run_audit_id: issuance?.base_run_audit_id == null ? null : Number(issuance.base_run_audit_id),
    created_by: String(issuance?.created_by || "forecast_engine"),
    rows: normalizedRows,
  };
}

const bulkUpsertForecastDayAhead = db.transaction((date, rows, source = "service", issuance = null) => {
  const day = String(date || "");
  const batch = Array.isArray(rows) ? rows : [];
  stmts.deleteForecastDayAheadDate.run(day);
  const now = Date.now();
  for (const r of batch) {
    stmts.upsertForecastDayAhead.run({
      date: day,
      ts: Number(r?.ts || 0),
      slot: Number(r?.slot || 0),
      time_hms: String(r?.time_hms || ""),
      kwh_inc: Number(r?.kwh_inc || 0),
      kwh_lo: Number(r?.kwh_lo || 0),
      kwh_hi: Number(r?.kwh_hi || 0),
      source: String(source || "service"),
      updated_ts: now,
    });
  }

  // Immutable replay history is written only when the caller supplies the
  // original issuance identity and canonical checksum. Generic context sync
  // deliberately updates only the mutable table; Date.now() is not an issue
  // timestamp and must never be promoted into causal replay evidence.
  if (issuance != null) {
    const validated = validateImmutableDayAheadIssuance(day, batch, source, issuance);
    stmts.insertForecastDayAheadIssuance.run(validated);
    for (const r of validated.rows) {
      stmts.insertForecastDayAheadImmutable.run({
        date: day,
        issuance_id: validated.issuance_id,
        generated_ts: validated.generated_ts,
        slot: Number(r?.slot || 0),
        time_hms: String(r?.time_hms || ""),
        kwh_inc: Number(r?.kwh_inc || 0),
        kwh_lo: Number(r?.kwh_lo || 0),
        kwh_hi: Number(r?.kwh_hi || 0),
        source: validated.source,
      });
    }
  }
});

const bulkUpsertForecastIntradayAdjusted = db.transaction((date, rows, source = "service") => {
  stmts.deleteForecastIntradayAdjustedDate.run(String(date || ""));
  const now = Date.now();
  for (const r of rows || []) {
    stmts.upsertForecastIntradayAdjusted.run({
      date: String(date || ""),
      ts: Number(r?.ts || 0),
      slot: Number(r?.slot || 0),
      time_hms: String(r?.time_hms || ""),
      kwh_inc: Number(r?.kwh_inc || 0),
      kwh_lo: Number(r?.kwh_lo || 0),
      kwh_hi: Number(r?.kwh_hi || 0),
      source: String(source || "service"),
      updated_ts: now,
      series_run_id: String(r?.series_run_id || "").trim() || null,
    });
  }
});

const bulkUpsertSolcastSnapshot = db.transaction((day, rows, source, pulledTs) => {
  const now = Date.now();
  for (const r of rows || []) {
    stmts.upsertSolcastSnapshot.run({
      forecast_day:    String(day || ""),
      slot:            Number(r.slot),
      ts_local:        Number(r.ts_local),
      period_end_utc:  r.period_end_utc != null ? String(r.period_end_utc) : null,
      period:          r.period         != null ? String(r.period)         : null,
      forecast_mw:     r.forecast_mw     != null ? Number(r.forecast_mw)     : null,
      forecast_lo_mw:  r.forecast_lo_mw  != null ? Number(r.forecast_lo_mw)  : null,
      forecast_hi_mw:  r.forecast_hi_mw  != null ? Number(r.forecast_hi_mw)  : null,
      est_actual_mw:   r.est_actual_mw   != null ? Number(r.est_actual_mw)   : null,
      forecast_kwh:    r.forecast_kwh    != null ? Number(r.forecast_kwh)    : null,
      forecast_lo_kwh: r.forecast_lo_kwh != null ? Number(r.forecast_lo_kwh) : null,
      forecast_hi_kwh: r.forecast_hi_kwh != null ? Number(r.forecast_hi_kwh) : null,
      est_actual_kwh:  r.est_actual_kwh  != null ? Number(r.est_actual_kwh)  : null,
      pulled_ts:       Number(pulledTs || now),
      source:          String(source || "toolkit"),
      updated_ts:      now,
    });
  }
});

/**
 * Backfill only est_actual_mw/est_actual_kwh for existing snapshot rows.
 * Skips rows that already have est_actual data to preserve earlier writes.
 * Returns the number of rows actually updated.
 */
const bulkBackfillSolcastEstActual = db.transaction((day, slotEstActuals) => {
  const now = Date.now();
  let updated = 0;
  for (const r of slotEstActuals || []) {
    if (r.est_actual_mw == null && r.est_actual_kwh == null) continue;
    const info = stmts.backfillSolcastEstActual.run({
      forecast_day:   String(day || ""),
      slot:           Number(r.slot),
      est_actual_mw:  r.est_actual_mw  != null ? Number(r.est_actual_mw)  : null,
      est_actual_kwh: r.est_actual_kwh != null ? Number(r.est_actual_kwh) : null,
      updated_ts:     now,
    });
    updated += info.changes;
  }
  return updated;
});

function getSolcastSnapshotForDay(day) {
  return stmts.getSolcastSnapshotDay.all(String(day || ""));
}

/**
 * Day-ahead locked snapshot bulk insert (v2.8+).
 * Uses INSERT OR IGNORE — first-write-wins per (forecast_day, slot).
 * Returns the number of rows actually inserted (0 if already locked).
 */
const bulkInsertDayAheadLocked = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows || []) {
    const info = stmts.insertDayAheadLocked.run({
      forecast_day:    String(r.forecast_day || ""),
      slot:            Number(r.slot),
      ts_local:        Number(r.ts_local || 0),
      period_end_utc:  r.period_end_utc != null ? String(r.period_end_utc) : null,
      period:          r.period         != null ? String(r.period)         : null,
      p50_mw:          r.p50_mw  != null ? Number(r.p50_mw)  : null,
      p10_mw:          r.p10_mw  != null ? Number(r.p10_mw)  : null,
      p90_mw:          r.p90_mw  != null ? Number(r.p90_mw)  : null,
      p50_kwh:         r.p50_kwh != null ? Number(r.p50_kwh) : null,
      p10_kwh:         r.p10_kwh != null ? Number(r.p10_kwh) : null,
      p90_kwh:         r.p90_kwh != null ? Number(r.p90_kwh) : null,
      spread_mw:       r.spread_mw      != null ? Number(r.spread_mw)      : null,
      spread_pct_cap:  r.spread_pct_cap != null ? Number(r.spread_pct_cap) : null,
      captured_ts:     Number(r.captured_ts || Date.now()),
      captured_local:  String(r.captured_local || ""),
      capture_reason:  String(r.capture_reason || "manual"),
      solcast_source:  String(r.solcast_source || "toolkit"),
      plant_cap_mw:    r.plant_cap_mw != null ? Number(r.plant_cap_mw) : null,
    });
    inserted += info.changes;
  }
  return inserted;
});

function countDayAheadLockedForDay(day) {
  return Number(stmts.countDayAheadLocked.get(String(day || ""))?.n || 0);
}

function getDayAheadLockedForDay(day) {
  return stmts.getDayAheadLocked.all(String(day || ""));
}

function getDayAheadLockedMetaForDay(day) {
  return stmts.getDayAheadLockedMeta.get(String(day || ""));
}

/**
 * Append Solcast snapshot history rows (v2.8+).
 * Append-only; INSERT OR REPLACE used because PRIMARY KEY includes captured_ts
 * so real duplicates should be rare but safe against collisions within the same ms.
 */
const bulkInsertSnapshotHistory = db.transaction((rows) => {
  let inserted = 0;
  for (const r of rows || []) {
    stmts.insertSnapshotHistory.run({
      forecast_day:   String(r.forecast_day || ""),
      slot:           Number(r.slot),
      captured_ts:    Number(r.captured_ts || Date.now()),
      pulled_ts:      Number(r.pulled_ts   || 0),
      p50_mw:         r.p50_mw        != null ? Number(r.p50_mw)        : null,
      p10_mw:         r.p10_mw        != null ? Number(r.p10_mw)        : null,
      p90_mw:         r.p90_mw        != null ? Number(r.p90_mw)        : null,
      est_actual_mw:  r.est_actual_mw != null ? Number(r.est_actual_mw) : null,
      age_sec:        r.age_sec       != null ? Number(r.age_sec)       : null,
      solcast_source: r.solcast_source != null ? String(r.solcast_source) : null,
    });
    inserted += 1;
  }
  return inserted;
});

/**
 * Migrate snapshot history rows older than `retainDays` to monthly archive
 * shards. v2.11.2 — was DELETE-only; the rows are the only forensic record
 * of Solcast trajectory drift per-pull, so a low operator retention setting
 * used to permanently lose the very data the forecast Performance Monitor
 * relies on for post-hoc diagnosis. Returns rows migrated.
 */
async function pruneSnapshotHistory(retainDays = 90) {
  const days = Math.max(1, Math.min(3650, Math.trunc(Number(retainDays || 90))));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return archiveTableBeforeCutoff({
    tableName: "solcast_snapshot_history",
    cutoffColumn: "captured_ts",
    cutoffValue: cutoff,
    monthKeyColumn: "captured_ts",
    monthKeyKind: "ms",
  });
}

function getSnapshotHistoryDayTrajectory(day) {
  return stmts.getSnapshotHistoryDayTrajectory.all(String(day || ""));
}

function getSetting(key, def = null) {
  try {
    if (!db || !db.open) return def;
    const row = stmts?.getSetting ? stmts.getSetting.get(key) : null;
    return row ? row.value : def;
  } catch (_) {
    return def;
  }
}
function setSetting(key, value) {
  try {
    if (!db || !db.open) return;
    if (stmts?.setSetting) {
      stmts.setSetting.run(key, String(value), Date.now());
    }
  } catch (_) {}
}

function normalizeChatMachine(machine, def = "gateway") {
  const v = String(machine || def)
    .trim()
    .toLowerCase();
  return v === "remote" ? "remote" : "gateway";
}

const insertChatMessage = db.transaction((row, retainCount = 500) => {
  const info = stmts.insertChatMessage.run({
    ts: Number(row?.ts || Date.now()),
    from_machine: normalizeChatMachine(row?.from_machine, "gateway"),
    to_machine: normalizeChatMachine(row?.to_machine, "remote"),
    from_name: String(row?.from_name || "").trim(),
    message: String(row?.message || ""),
    read_ts:
      row?.read_ts == null || row?.read_ts === ""
        ? null
        : Number(row.read_ts || 0),
  });
  const keep = Math.max(1, Math.trunc(Number(retainCount || 500)));
  stmts.purgeChatOverflow.run(keep);
  return stmts.getChatMessageById.get(info.lastInsertRowid);
});

function getChatThread(limit = 20) {
  const cap = Math.max(1, Math.min(100, Math.trunc(Number(limit || 20))));
  return stmts.getChatThread.all(cap);
}

function getChatInboxAfterId(machine, afterId = 0, limit = 50) {
  const normalizedMachine = normalizeChatMachine(machine, "gateway");
  const after = Math.max(0, Math.trunc(Number(afterId || 0)));
  const cap = Math.max(1, Math.min(200, Math.trunc(Number(limit || 50))));
  return stmts.getChatInboxAfterId.all(normalizedMachine, after, cap);
}

function getLatestChatInboundId(machine) {
  const normalizedMachine = normalizeChatMachine(machine, "gateway");
  const row = stmts.getLatestChatInboundId.get(normalizedMachine);
  return Math.max(0, Math.trunc(Number(row?.id || 0)));
}

function markChatReadUpToId(machine, upToId, readTs = Date.now()) {
  const normalizedMachine = normalizeChatMachine(machine, "gateway");
  const maxId = Math.max(0, Math.trunc(Number(upToId || 0)));
  if (!maxId) return 0;
  const info = stmts.markChatReadUpToId.run(
    Math.max(0, Math.trunc(Number(readTs || Date.now()))),
    normalizedMachine,
    maxId,
  );
  return Math.max(0, Math.trunc(Number(info?.changes || 0)));
}

function clearAllChatMessages() {
  const info = stmts.clearChatMessages.run();
  return Math.max(0, Math.trunc(Number(info?.changes || 0)));
}

function ensureArchiveSchema(archiveDb) {
  archiveDb.pragma("journal_mode = WAL");
  archiveDb.pragma("synchronous = NORMAL");
  archiveDb.pragma("busy_timeout = 1000");   // Low timeout: archive DBs written only during migration; fail fast
  archiveDb.pragma("temp_store = memory");
  archiveDb.pragma("cache_size = -8000");    // 8 MB per archive DB (was 64 MB default)
  archiveDb.exec(`
    CREATE TABLE IF NOT EXISTS readings (
      ${ARCHIVE_READING_TABLE_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_ar_ts ON readings(ts);
    CREATE INDEX IF NOT EXISTS idx_ar_inv_ts ON readings(inverter, unit, ts);

    CREATE TABLE IF NOT EXISTS energy_5min (
      id        INTEGER PRIMARY KEY,
      ts        INTEGER NOT NULL,
      inverter  INTEGER NOT NULL,
      kwh_inc   REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ae5_ts ON energy_5min(ts);
    CREATE INDEX IF NOT EXISTS idx_ae5_inv_ts ON energy_5min(inverter, ts);

    CREATE TABLE IF NOT EXISTS alarms (
      ${ARCHIVE_ALARM_TABLE_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_aa_ts     ON alarms(ts);
    CREATE INDEX IF NOT EXISTS idx_aa_inv_ts ON alarms(inverter, ts);

    CREATE TABLE IF NOT EXISTS audit_log (
      ${ARCHIVE_AUDIT_TABLE_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_aau_ts     ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_aau_inv_ts ON audit_log(inverter, ts);

    CREATE TABLE IF NOT EXISTS inverter_stop_reasons (
      ${ARCHIVE_STOP_REASONS_TABLE_DDL}
    );
    CREATE INDEX IF NOT EXISTS idx_asr_read_at  ON inverter_stop_reasons(read_at_ms);
    CREATE INDEX IF NOT EXISTS idx_asr_alarm_id ON inverter_stop_reasons(alarm_id);
    CREATE INDEX IF NOT EXISTS idx_asr_inv_read ON inverter_stop_reasons(inverter_id, read_at_ms);
  `);
}

function createArchiveEntry(filePath) {
  const existed = fs.existsSync(filePath);
  const archiveDb = new Database(filePath);
  // Always run ensureArchiveSchema — it's idempotent (`CREATE TABLE IF NOT
  // EXISTS` + `CREATE INDEX IF NOT EXISTS`) and ensures pre-existing
  // archive DBs gain new tables added by later versions (e.g. the
  // `alarms` shard added in v2.11.0-beta.10 for alarm-history archiving).
  // Cost is a single PRAGMA + a few existence checks per LRU miss —
  // negligible vs the open syscall itself.
  ensureArchiveSchema(archiveDb);
  void existed; // retained for documentation of the prior fast-path
  const entry = {
    db: archiveDb,
    insertReading: archiveDb.prepare(`
      INSERT OR IGNORE INTO readings
      (id,ts,inverter,unit,pac,kwh,alarm,online)
      VALUES (@id,@ts,@inverter,@unit,@pac,@kwh,@alarm,@online)
    `),
    insertEnergy5: archiveDb.prepare(`
      INSERT OR IGNORE INTO energy_5min (id,ts,inverter,kwh_inc)
      VALUES (@id,@ts,@inverter,@kwh_inc)
    `),
    selectReadingsRangeAll: archiveDb.prepare(
      `SELECT ${READING_SELECT_SQL} FROM readings WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, unit ASC, ts ASC`,
    ),
    selectReadingsRangeByInv: archiveDb.prepare(
      `SELECT ${READING_SELECT_SQL} FROM readings WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
    ),
    // Mirror of stmts.selectReadingBucketsRange / selectMaxReadingTs so the
    // archive-aware helpers can union month shards without materialising rows.
    selectReadingBucketsRange: archiveDb.prepare(
      `SELECT DISTINCT (ts / ?) AS b FROM readings WHERE ts >= ? AND ts < ?`,
    ),
    selectMaxReadingTs: archiveDb.prepare(`SELECT MAX(ts) AS m FROM readings`),
    selectEnergyRangeAll: archiveDb.prepare(
      `SELECT * FROM energy_5min WHERE ts BETWEEN ? AND ? ORDER BY inverter ASC, ts ASC`,
    ),
    selectEnergyRangeByInv: archiveDb.prepare(
      `SELECT * FROM energy_5min WHERE inverter=? AND ts BETWEEN ? AND ? ORDER BY ts ASC`,
    ),
    sumEnergyRangeAll: archiveDb.prepare(
      `SELECT inverter, SUM(kwh_inc) AS total_kwh
         FROM energy_5min
        WHERE ts BETWEEN ? AND ?
        GROUP BY inverter
        ORDER BY inverter ASC`,
    ),
    sumEnergyRangeByInv: archiveDb.prepare(
      `SELECT inverter, SUM(kwh_inc) AS total_kwh
         FROM energy_5min
        WHERE inverter=? AND ts BETWEEN ? AND ?
        GROUP BY inverter`,
    ),
    // ─── Alarms shard (v2.11.0-beta.10) ────────────────────────────────
    // Mirrors stmts.getAlarmsRange / its by-inverter sibling so the
    // archive-aware reader can merge hot + archive results with a
    // stable column projection. Range queries are ORDER BY ts DESC
    // because that's what the alarm-log UI consumes.
    insertAlarm: archiveDb.prepare(`
      INSERT OR IGNORE INTO alarms
      (id, ts, inverter, unit, alarm_code, alarm_value, severity,
       cleared_ts, acknowledged, updated_ts, stop_reason_id)
      VALUES (@id, @ts, @inverter, @unit, @alarm_code, @alarm_value,
              @severity, @cleared_ts, @acknowledged, @updated_ts,
              @stop_reason_id)
    `),
    selectAlarmsRangeAll: archiveDb.prepare(
      `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
         FROM alarms
        WHERE ts BETWEEN ? AND ?
        ORDER BY ts DESC`,
    ),
    selectAlarmsRangeByInv: archiveDb.prepare(
      `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
         FROM alarms
        WHERE inverter=? AND ts BETWEEN ? AND ?
        ORDER BY ts DESC`,
    ),
    // ─── Audit log shard (v2.11.1) ─────────────────────────────────────
    // Mirrors the hot DB's audit_log row shape so the archive-aware
    // reader can merge hot + archive results with a stable column
    // projection. Range queries are ORDER BY ts DESC because the
    // /api/audit endpoint and operator log UI both consume newest-first.
    insertAudit: archiveDb.prepare(`
      INSERT OR IGNORE INTO audit_log
      (id, ts, operator, inverter, node, action, scope, result, ip, reason)
      VALUES (@id, @ts, @operator, @inverter, @node, @action, @scope,
              @result, @ip, @reason)
    `),
    selectAuditRangeAll: archiveDb.prepare(
      `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
         FROM audit_log
        WHERE ts BETWEEN ? AND ?
        ORDER BY ts DESC`,
    ),
    selectAuditRangeByInv: archiveDb.prepare(
      `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
         FROM audit_log
        WHERE inverter=? AND ts BETWEEN ? AND ?
        ORDER BY ts DESC`,
    ),
    // ─── Stop-reason snapshots shard (v2.11.1-beta.1) ──────────────────
    // Mirror of hot stop_reasons row shape so findStopReasonByIdArchiveAware
    // can fall back to archives when an alarm's drilldown click lands on a
    // row that's already migrated out of hot.
    insertStopReason: archiveDb.prepare(`
      INSERT OR IGNORE INTO inverter_stop_reasons
        (id, inverter_id, inverter_ip, slave, node,
         read_at_ms, event_at_ms, trigger_source, alarm_id,
         pot_ac, vpv, vac1, vac2, vac3, iac1, iac2,
         frec1, frec2, frec3, cos, temp,
         alarma, motparo, motparo_label,
         alarmas1, alarmas2, flags,
         ref1, pos1, ref2, pos2,
         timeout_band, debug_desc,
         struct_month, struct_day, struct_hour, struct_min,
         raw_hex, fingerprint, updated_ts)
      VALUES (@id, @inverter_id, @inverter_ip, @slave, @node,
              @read_at_ms, @event_at_ms, @trigger_source, @alarm_id,
              @pot_ac, @vpv, @vac1, @vac2, @vac3, @iac1, @iac2,
              @frec1, @frec2, @frec3, @cos, @temp,
              @alarma, @motparo, @motparo_label,
              @alarmas1, @alarmas2, @flags,
              @ref1, @pos1, @ref2, @pos2,
              @timeout_band, @debug_desc,
              @struct_month, @struct_day, @struct_hour, @struct_min,
              @raw_hex, @fingerprint, @updated_ts)
    `),
    selectStopReasonById: archiveDb.prepare(
      `SELECT * FROM inverter_stop_reasons WHERE id = ?`,
    ),
    selectStopReasonsByAlarmId: archiveDb.prepare(
      `SELECT * FROM inverter_stop_reasons WHERE alarm_id = ?
         ORDER BY read_at_ms DESC LIMIT 1`,
    ),
  };
  entry.insertReadingsTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertReading.run(row);
  });
  entry.insertEnergyTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertEnergy5.run(row);
  });
  entry.insertAlarmsTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertAlarm.run(row);
  });
  entry.insertAuditTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertAudit.run(row);
  });
  entry.insertStopReasonsTx = archiveDb.transaction((rows) => {
    for (const row of rows || []) entry.insertStopReason.run(row);
  });
  return entry;
}

function normalizeArchiveMonthKey(monthKey) {
  return String(monthKey || "")
    .trim()
    .replace(/\.db$/i, "");
}

function evictLruArchiveEntries() {
  if (ARCHIVE_DB_CACHE.size < ARCHIVE_DB_CACHE_MAX_ENTRIES) return 0;
  // Bounded eviction loop. If every cached entry is replace-locked (should
  // be very rare — only during atomic archive file swaps) we bail rather than
  // spin forever.
  let evicted = 0;
  let attempts = 0;
  const safetyCap = ARCHIVE_DB_CACHE.size * 2 + 4;
  while (ARCHIVE_DB_CACHE.size >= ARCHIVE_DB_CACHE_MAX_ENTRIES && attempts < safetyCap) {
    attempts++;
    const oldestKey = ARCHIVE_DB_CACHE.keys().next().value;
    if (!oldestKey) break;
    if (ARCHIVE_DB_REPLACE_LOCKS.has(oldestKey)) {
      // Skip over the locked entry by moving it to the most-recent position;
      // a later eviction pass will revisit once the lock clears.
      const skipped = ARCHIVE_DB_CACHE.get(oldestKey);
      ARCHIVE_DB_CACHE.delete(oldestKey);
      ARCHIVE_DB_CACHE.set(oldestKey, skipped);
      continue;
    }
    if (closeArchiveDbForMonth(oldestKey)) {
      evicted++;
      _archiveLruEvictionCount++;
      _archiveLruLastEvictedKey = oldestKey;
      _archiveLruLastEvictedAtMs = Date.now();
    }
  }
  return evicted;
}

function getArchiveEntry(monthKey, createIfMissing = false) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return null;
  if (ARCHIVE_DB_REPLACE_LOCKS.has(key)) return null;
  if (ARCHIVE_DB_CACHE.has(key)) {
    // LRU bump: re-inserting moves the entry to the end of the Map's
    // insertion-order, so .keys().next() always points at the oldest unused
    // month for eviction below.
    const cached = ARCHIVE_DB_CACHE.get(key);
    ARCHIVE_DB_CACHE.delete(key);
    ARCHIVE_DB_CACHE.set(key, cached);
    return cached;
  }
  const filePath = path.join(ARCHIVE_DIR, `${key}.db`);
  if (!createIfMissing && !fs.existsSync(filePath)) return null;
  evictLruArchiveEntries();
  const entry = createArchiveEntry(filePath);
  ARCHIVE_DB_CACHE.set(key, entry);
  return entry;
}

function getArchiveCacheStats() {
  return {
    openMonths: ARCHIVE_DB_CACHE.size,
    maxOpenMonths: ARCHIVE_DB_CACHE_MAX_ENTRIES,
    months: Array.from(ARCHIVE_DB_CACHE.keys()), // ordered LRU-oldest → newest
    replaceLocked: Array.from(ARCHIVE_DB_REPLACE_LOCKS.values()),
    evictionCount: _archiveLruEvictionCount,
    lastEvictedKey: _archiveLruLastEvictedKey,
    lastEvictedAtMs: _archiveLruLastEvictedAtMs,
  };
}

function closeArchiveDbForMonth(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return false;
  const entry = ARCHIVE_DB_CACHE.get(key);
  if (!entry) return false;
  try {
    entry.db.pragma("wal_checkpoint(PASSIVE)"); // PASSIVE: non-blocking — checkpoints what it can without waiting for readers
  } catch (_) {
    // Ignore archive checkpoint failures during targeted close.
  }
  try {
    entry.db.close();
  } catch (_) {
    // Ignore archive close failures during targeted close.
  }
  ARCHIVE_DB_CACHE.delete(key);
  // Drop the generic schema cache for this month so a future open re-runs
  // ensureArchiveTableSchema (in case the file was replaced atomically by
  // a transfer or recovery worker between close and re-open). Also clear
  // any prepared INSERT statements bound to the just-closed handle —
  // calling them post-close would crash with SQLITE_MISUSE.
  ARCHIVE_GENERIC_SCHEMA_CACHE.delete(key);
  for (const stmtKey of Array.from(ARCHIVE_PER_SHARD_INSERT_CACHE.keys())) {
    if (stmtKey.startsWith(`${key}|`)) {
      ARCHIVE_PER_SHARD_INSERT_CACHE.delete(stmtKey);
    }
  }
  return true;
}

function prepareArchiveDbForTransfer(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return { closed: false, checkpointed: false, walBytes: 0 };
  const entry = ARCHIVE_DB_CACHE.get(key);
  if (!entry) return { closed: false, checkpointed: false, walBytes: 0 };
  const filePath = path.join(ARCHIVE_DIR, `${key}.db`);
  const walPath = `${filePath}-wal`;
  let walBytes = 0;
  try {
    walBytes = Math.max(0, Number(fs.statSync(walPath).size || 0));
  } catch (_) {
    walBytes = 0;
  }
  if (!(walBytes > 0)) {
    return { closed: false, checkpointed: false, walBytes: 0 };
  }
  try {
    entry.db.pragma("wal_checkpoint(PASSIVE)");
  } catch (_) {
    // Ignore passive checkpoint failures; we may still need a targeted close.
  }
  try {
    walBytes = Math.max(0, Number(fs.statSync(walPath).size || 0));
  } catch (_) {
    walBytes = 0;
  }
  if (!(walBytes > 0)) {
    return { closed: false, checkpointed: true, walBytes: 0 };
  }
  return {
    closed: closeArchiveDbForMonth(key),
    checkpointed: true,
    walBytes,
  };
}

async function createSqliteTransferSnapshot(
  sourcePath,
  { targetDir = "", prefix = "", mtimeMs = 0 } = {},
) {
  const resolvedSource = path.resolve(String(sourcePath || "").trim());
  if (!resolvedSource || !fs.existsSync(resolvedSource)) {
    throw new Error("SQLite snapshot source file is missing.");
  }
  const snapshotDir = String(targetDir || path.dirname(resolvedSource)).trim() ||
    path.dirname(resolvedSource);
  await fs.promises.mkdir(snapshotDir, { recursive: true });
  const sourceBase = path.basename(resolvedSource, path.extname(resolvedSource)) || "sqlite";
  const safePrefix = String(prefix || `${sourceBase}.snapshot`)
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "") || `${sourceBase}.snapshot`;
  const tempPath = path.join(
    snapshotDir,
    `${safePrefix}-${Date.now()}-${process.pid}.tmp`,
  );
  let sourceDb = null;
  try {
    sourceDb = new Database(resolvedSource, { fileMustExist: true });
    try { sourceDb.pragma("busy_timeout = 1000"); } catch (_) {}  // Low timeout: source DB for archive transfer; fail fast
    await sourceDb.backup(tempPath);
    const stat = await fs.promises.stat(tempPath);
    const targetMtimeMs = Math.max(0, Number(mtimeMs || stat?.mtimeMs || Date.now()));
    if (targetMtimeMs > 0) {
      const mtime = new Date(targetMtimeMs);
      await fs.promises.utimes(tempPath, mtime, mtime);
    }
    return {
      tempPath,
      size: Math.max(0, Number(stat?.size || 0)),
      mtimeMs: targetMtimeMs,
    };
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch (_) {
      // Ignore temp cleanup failures after snapshot build errors.
    }
    throw err;
  } finally {
    if (sourceDb) {
      try { sourceDb.close(); } catch (_) {}
    }
  }
}

async function disposeSqliteTransferSnapshot(snapshotOrPath) {
  const tempPath =
    typeof snapshotOrPath === "string"
      ? String(snapshotOrPath || "").trim()
      : String(snapshotOrPath?.tempPath || "").trim();
  if (!tempPath) return false;
  try {
    await fs.promises.unlink(tempPath);
    return true;
  } catch (err) {
    if (String(err?.code || "").trim().toUpperCase() === "ENOENT") return false;
    throw err;
  }
}

function upsertDailyReportRowsToSnapshot(snapshotPath, rowsRaw = []) {
  const targetPath = String(snapshotPath || "").trim();
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw new Error("Snapshot file is missing.");
  }
  const rows = Array.isArray(rowsRaw)
    ? rowsRaw
      .map((row) => ({
        date: String(row?.date || "").trim(),
        inverter: Math.max(0, Number(row?.inverter || 0)),
        kwh_total: Number(row?.kwh_total || 0),
        pac_peak: Number(row?.pac_peak || 0),
        pac_avg: Number(row?.pac_avg || 0),
        uptime_s: Math.max(0, Math.round(Number(row?.uptime_s || 0))),
        alarm_count: Math.max(0, Math.trunc(Number(row?.alarm_count || 0))),
        control_count: Math.max(0, Math.trunc(Number(row?.control_count || 0))),
        availability_pct: Number(row?.availability_pct || 0),
        performance_pct: Number(row?.performance_pct || 0),
        node_uptime_s: Math.max(0, Math.round(Number(row?.node_uptime_s || 0))),
        expected_node_uptime_s: Math.max(0, Math.round(Number(row?.expected_node_uptime_s || 0))),
        expected_nodes: Math.max(0, Math.trunc(Number(row?.expected_nodes || 0))),
        rated_kw: Number(row?.rated_kw || 0),
      }))
      .filter((row) => row.date && row.inverter > 0)
    : [];
  if (!rows.length) return 0;

  const snapshotDb = new Database(targetPath, { fileMustExist: true });
  try {
    try { snapshotDb.pragma("journal_mode = DELETE"); } catch (_) {}
    try { snapshotDb.pragma("synchronous = NORMAL"); } catch (_) {}
    const upsert = snapshotDb.prepare(`
      INSERT INTO daily_report(
        date,inverter,kwh_total,pac_peak,pac_avg,uptime_s,alarm_count,control_count,
        availability_pct,performance_pct,node_uptime_s,expected_node_uptime_s,expected_nodes,rated_kw,updated_ts
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
      ON CONFLICT(date,inverter) DO UPDATE SET
        kwh_total=excluded.kwh_total,
        pac_peak=excluded.pac_peak,
        pac_avg=excluded.pac_avg,
        uptime_s=excluded.uptime_s,
        alarm_count=excluded.alarm_count,
        control_count=excluded.control_count,
        availability_pct=excluded.availability_pct,
        performance_pct=excluded.performance_pct,
        node_uptime_s=excluded.node_uptime_s,
        expected_node_uptime_s=excluded.expected_node_uptime_s,
        expected_nodes=excluded.expected_nodes,
        rated_kw=excluded.rated_kw,
        updated_ts=CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    `);
    const tx = snapshotDb.transaction((entries) => {
      for (const row of entries) {
        upsert.run(
          row.date,
          row.inverter,
          row.kwh_total,
          row.pac_peak,
          row.pac_avg,
          row.uptime_s,
          row.alarm_count,
          row.control_count,
          row.availability_pct,
          row.performance_pct,
          row.node_uptime_s,
          row.expected_node_uptime_s,
          row.expected_nodes,
          row.rated_kw,
        );
      }
    });
    tx(rows);
    return rows.length;
  } finally {
    try { snapshotDb.close(); } catch (_) {}
  }
}

function beginArchiveDbReplacement(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return "";
  ARCHIVE_DB_REPLACE_LOCKS.add(key);
  closeArchiveDbForMonth(key);
  return key;
}

function endArchiveDbReplacement(monthKey) {
  const key = normalizeArchiveMonthKey(monthKey);
  if (!key) return false;
  return ARCHIVE_DB_REPLACE_LOCKS.delete(key);
}

function parseIntervalsJson(text) {
  try {
    const parsed = JSON.parse(String(text || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        const start = Number(pair[0] || 0);
        const end = Number(pair[1] || 0);
        return end > start && start > 0 ? [start, end] : null;
      })
      .filter(Boolean)
      .sort((a, b) => Number(a[0]) - Number(b[0]) || Number(a[1]) - Number(b[1]));
  } catch (_) {
    return [];
  }
}

function addMergedInterval(intervals, start, end) {
  const s = Number(start || 0);
  const e = Number(end || 0);
  if (!(e > s) || !(s > 0)) return;
  const list = Array.isArray(intervals) ? intervals : [];
  if (!list.length) {
    list.push([s, e]);
    return;
  }
  const last = list[list.length - 1];
  if (s <= Number(last[1] || 0)) {
    if (e > Number(last[1] || 0)) last[1] = e;
    return;
  }
  list.push([s, e]);
}

function createSummaryState(day, inverter, unit, row = null) {
  return {
    date: String(day || ""),
    inverter: Number(inverter || row?.inverter || 0),
    unit: Number(unit || row?.unit || 0),
    sample_count: Math.max(0, Math.trunc(Number(row?.sample_count || 0))),
    online_samples: Math.max(0, Math.trunc(Number(row?.online_samples || 0))),
    pac_online_sum: Number(row?.pac_online_sum || 0),
    pac_online_count: Math.max(0, Math.trunc(Number(row?.pac_online_count || 0))),
    pac_peak: Number(row?.pac_peak || 0),
    first_ts: Number(row?.first_ts || 0),
    last_ts: Number(row?.last_ts || 0),
    first_kwh: Number(row?.first_kwh || 0),
    last_kwh: Number(row?.last_kwh || 0),
    last_online: Number(row?.last_online || 0) === 1 ? 1 : 0,
    intervals: parseIntervalsJson(row?.intervals_json),
    pac_kwh_raw: Number(row?.pac_kwh_raw || 0),
    is_final: 0,
    _kwhTs: Number(row?.last_ts || 0),   // resume trapezoid from persisted last_ts
    _kwhPac: Number(row?.last_pac_w || 0),
  };
}

function applyReadingToSummaryState(state, row) {
  if (!state || !row) return;
  const ts = Number(row?.ts || 0);
  if (!(ts > 0)) return;
  const pac = Math.max(0, Number(row?.pac || 0));
  const kwh = Number(row?.kwh || 0);
  /* ── Node-level online definition ───────────────────────────────────────
     A node is "online" (contributing to the uptime interval) when it is
     communicating AND at least one of:
       • PAC > 0 (actively generating), or
       • A non-manual-stop fault alarm is active (faulted but trying to run).

     Manual-stop (alarm 0x1000): node is online ONLY if PAC > 0.
     If PAC = 0 with 0x1000, the node is offline and its interval closes.

     INVERTER-LEVEL behaviour (buildDailyReportRowsForDate):
     The availability penalty for 0x1000 only materialises when ALL configured
     nodes are simultaneously offline — i.e., the union of all node intervals
     has a gap. If only SOME nodes are manually stopped but others continue
     generating, their intervals cover the gap → no inverter-level penalty.
     This implements the rule: "penalise 0x1000 only when all nodes have
     PAC = 0 AND all nodes carry the 0x1000 alarm bit."                     */
  const alarmVal = Number(row?.alarm || 0);
  const isManualStop = (alarmVal & 0x1000) !== 0;
  const hasFaultAlarm = alarmVal > 0 && !isManualStop;
  const isOnline = Number(row?.online || 0) === 1 && (pac > 0 || hasFaultAlarm);

  state.sample_count += 1;
  if (isOnline) {
    state.online_samples += 1;
    state.pac_online_sum += pac;
    state.pac_online_count += 1;
  }
  if (pac > state.pac_peak) state.pac_peak = pac;

  if (!(state.first_ts > 0) || ts < state.first_ts) {
    state.first_ts = ts;
    state.first_kwh = Number.isFinite(kwh) ? kwh : 0;
  }

  if (state.last_ts > 0 && ts > state.last_ts && state.last_online === 1) {
    const maxEnd = state.last_ts + SUMMARY_MAX_GAP_S * 1000;
    addMergedInterval(state.intervals, state.last_ts, Math.min(ts, maxEnd));
  }

  if (!(state.last_ts > 0) || ts >= state.last_ts) {
    state.last_ts = ts;
    state.last_kwh = Number.isFinite(kwh) ? kwh : state.last_kwh;
    state.last_online = isOnline ? 1 : 0;
  }

  // Trapezoidal PAC integration — same 30 s cap as exporter.js COMPUTED_ENERGY_MAX_DT_MS.
  if (ts > state._kwhTs) {
    if (state._kwhTs > 0) {
      const dt = Math.min(ts - state._kwhTs, SUMMARY_PAC_KWH_MAX_DT_MS);
      state.pac_kwh_raw += (state._kwhPac + pac) * 0.5 * dt / 3_600_000_000;
    }
    state._kwhTs = ts;
    state._kwhPac = pac;
  }
}

function summaryStateToPayload(state, updatedTs = Date.now()) {
  return {
    date: state.date,
    inverter: Number(state.inverter || 0),
    unit: Number(state.unit || 0),
    sample_count: Math.max(0, Math.trunc(Number(state.sample_count || 0))),
    online_samples: Math.max(0, Math.trunc(Number(state.online_samples || 0))),
    pac_online_sum: Number(Number(state.pac_online_sum || 0).toFixed(6)),
    pac_online_count: Math.max(0, Math.trunc(Number(state.pac_online_count || 0))),
    pac_peak: Number(Number(state.pac_peak || 0).toFixed(3)),
    first_ts: Number(state.first_ts || 0),
    last_ts: Number(state.last_ts || 0),
    first_kwh: Number(Number(state.first_kwh || 0).toFixed(6)),
    last_kwh: Number(Number(state.last_kwh || 0).toFixed(6)),
    last_online: Number(state.last_online || 0) === 1 ? 1 : 0,
    intervals_json: JSON.stringify(Array.isArray(state.intervals) ? state.intervals : []),
    pac_kwh_raw: Number(Number(state.pac_kwh_raw || 0).toFixed(6)),
    last_pac_w: Number(Number(state._kwhPac || 0).toFixed(3)),
    is_final: Number(state.is_final || 0) === 1 ? 1 : 0,
    updated_ts: Number(updatedTs || Date.now()),
  };
}

const writeSummaryPayloadsTx = db.transaction((payloads, dayToDelete = "") => {
  if (dayToDelete) stmts.deleteDailyReadingsSummaryDay.run(String(dayToDelete));
  for (const payload of payloads || []) {
    stmts.upsertDailyReadingsSummary.run(payload);
  }
});

function getDailyReadingsSummaryRows(dayInput) {
  const day = String(dayInput || "").trim();
  if (!day) return [];
  return stmts.getDailyReadingsSummaryDay.all(day);
}

function ingestDailyReadingsSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return;
  const states = new Map();
  for (const row of list) {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(ts > 0) || !(inverter > 0) || !(unit > 0)) continue;
    const day = localDateStr(ts);
    const key = `${day}|${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      const existing = stmts.getDailyReadingsSummaryOne.get(day, inverter, unit);
      state = createSummaryState(day, inverter, unit, existing);
      states.set(key, state);
    }
    applyReadingToSummaryState(state, row);
  }
  if (!states.size) return;
  const now = Date.now();
  const payloads = Array.from(states.values()).map((state) => summaryStateToPayload(state, now));
  writeSummaryPayloadsTx(payloads);
}

const _stmtMarkDayFinal = db.prepare(
  `UPDATE daily_readings_summary SET is_final=1, updated_ts=? WHERE date=? AND is_final=0`,
);

function markDailyUnitsFinal(dayInput) {
  const day = String(dayInput || "").trim();
  if (!day) return 0;
  const result = _stmtMarkDayFinal.run(Date.now(), day);
  return result.changes || 0;
}

function getFinalizedDailySummaryRange(startDate, endDate) {
  const s = String(startDate || "").trim();
  const e = String(endDate || "").trim();
  if (!s || !e) return [];
  return stmts.getFinalizedDailySummaryRange.all(s, e);
}

// v2.11.x — Fetch every daily summary row in the range (live + finalized).
// Used by the export fast-path to read today's running pac_kwh_raw instead
// of recomputing from raw readings — eliminates the dashboard freeze that
// hit during full-range exports because today's slice was always slow-path.
//
// Each returned row carries `is_final` (0=live, 1=finalized) and
// `updated_ts` so the caller can decide whether the live value is fresh
// enough or whether the row should be ignored in favor of a slow-path
// rescan. Callers should NOT assume liveness — the freshness check lives
// at the call site, not here.
function getDailyRunningSummaryRange(startDate, endDate) {
  const s = String(startDate || "").trim();
  const e = String(endDate || "").trim();
  if (!s || !e) return [];
  return stmts.getDailyRunningSummaryRange.all(s, e);
}

function readingsNaturalKey(row) {
  return `${Number(row?.ts || 0)}|${Number(row?.inverter || 0)}|${Number(row?.unit || 0)}`;
}

function energyNaturalKey(row) {
  return `${Number(row?.ts || 0)}|${Number(row?.inverter || 0)}`;
}

function sortReadingsAsc(a, b) {
  return (
    Number(a?.inverter || 0) - Number(b?.inverter || 0) ||
    Number(a?.unit || 0) - Number(b?.unit || 0) ||
    Number(a?.ts || 0) - Number(b?.ts || 0)
  );
}

function sortEnergyAsc(a, b) {
  return (
    Number(a?.inverter || 0) - Number(b?.inverter || 0) ||
    Number(a?.ts || 0) - Number(b?.ts || 0)
  );
}

function annotateRowsWithComputedKwh(rowsRaw, maxGapMs = 30000) {
  const rows = Array.isArray(rowsRaw) ? rowsRaw.slice() : [];
  const lastByKey = new Map();
  const totalByKey = new Map();
  return rows.map((row) => {
    const ts = Number(row?.ts || 0);
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    const pac = Math.max(0, Number(row?.pac || 0));
    const key = `${localDateStr(ts)}|${inverter}|${unit}`;
    const prev = lastByKey.get(key);
    let totalKwh = Number(totalByKey.get(key) || 0);

    if (prev && ts > prev.ts) {
      const dtMs = ts - prev.ts;
      if (dtMs > 0 && dtMs <= maxGapMs) {
        const avgPac = (prev.pac + pac) / 2;
        totalKwh += (avgPac * dtMs) / 3600000000.0;
      }
    }

    totalKwh = Number(totalKwh.toFixed(6));
    lastByKey.set(key, { ts, pac });
    totalByKey.set(key, totalKwh);
    return { ...row, kwh: totalKwh };
  });
}

function pushUniqueRows(targetMap, rows, keyFn) {
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!targetMap.has(key)) targetMap.set(key, row);
  }
}

function queryReadingsRangeAll(startTs, endTs) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  // Warn on ranges > 2 days (operator hint — not enforced).
  const MAX_RANGE_MS = 2 * 24 * 60 * 60 * 1000;
  if (e - s > MAX_RANGE_MS) {
    console.warn(`[DB] queryReadingsRangeAll: range ${Math.round((e-s)/86400000)}d exceeds 2d cap — please use per-inverter path or batch with yields`);
  }
  // Note: v2.8.2 added a 500k row throw here ("E4") which caused exports to
  // fail on high-poll-rate deployments. Reverted to v2.7.x behaviour — the
  // route-level 366-day cap (MAX_EXPORT_RANGE_DAYS in server/index.js) is
  // the load bound. If a pathological range somehow slips through, the
  // caller will OOM loudly, which is preferable to silently blocking a
  // valid operator-requested export.
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectReadingsRangeAll.all(s, e), readingsNaturalKey);
    if (out.size > READINGS_RANGE_MAX_ROWS) {
      throw _rangeRowCapError("readings", out.size, READINGS_RANGE_MAX_ROWS, "ADSI_READINGS_RANGE_MAX_ROWS");
    }
  }
  pushUniqueRows(out, stmts.getReadingsRangeAll.all(s, e), readingsNaturalKey);
  if (out.size > READINGS_RANGE_MAX_ROWS) {
    throw _rangeRowCapError("readings", out.size, READINGS_RANGE_MAX_ROWS, "ADSI_READINGS_RANGE_MAX_ROWS");
  }
  return Array.from(out.values()).sort(sortReadingsAsc);
}

function queryReadingsRange(inverter, startTs, endTs) {
  const inv = Number(inverter || 0);
  if (!(inv > 0)) return [];
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectReadingsRangeByInv.all(inv, s, e), readingsNaturalKey);
  }
  pushUniqueRows(out, stmts.getReadingsRange.all(inv, s, e), readingsNaturalKey);
  return Array.from(out.values()).sort(sortReadingsAsc);
}

// ─── Alarms: archive-aware range reader (v2.11.0-beta.10) ──────────────────
// Mirrors queryReadingsRangeAll but for the alarms table. Hot DB is queried
// first, then every monthly archive that overlaps [s,e]. Results merge by
// natural key (id alone is stable because the hot id is preserved when the
// row migrates to archive — see ARCHIVE_ALARM_TABLE_DDL "INTEGER PRIMARY
// KEY" without AUTOINCREMENT and the INSERT OR IGNORE archive write).
// Sort is ts DESC (newest first — what the alarm-log UI consumes) and the
// caller-supplied limit is applied AFTER the merge so an old-and-new union
// still respects the response cap.
function alarmsNaturalKey(row) {
  return Number(row?.id || 0);
}
function sortAlarmsDesc(a, b) {
  return (
    Number(b?.ts || 0) - Number(a?.ts || 0) ||
    Number(b?.id || 0) - Number(a?.id || 0)
  );
}
// Look up a single alarm row by id, checking hot DB first, then iterating
// every monthly archive shard until found. The hot id is preserved when
// the row migrates to archive (INSERT OR IGNORE + INTEGER PRIMARY KEY
// without AUTOINCREMENT on archive side; hot side uses AUTOINCREMENT so
// new inserts never reuse a migrated id). Returns null when nothing found.
// Used by the alarm-drilldown endpoint (/api/alarms/:alarm_id/stop-reason)
// so clicking on a past-date row in the alarm-log table still resolves to
// the originating row even after it has been pruned from hot.
function findAlarmByIdArchiveAware(alarmId) {
  const id = Math.trunc(Number(alarmId || 0));
  if (!(id > 0)) return null;
  const hot = db
    .prepare(
      `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
         FROM alarms WHERE id = ?`,
    )
    .get(id);
  if (hot) return hot;
  // Newest archives first — drilldowns are usually on recent rows.
  let monthKeys = [];
  try {
    monthKeys = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((name) => /^\d{4}-\d{2}\.db$/.test(name))
      .map((name) => name.replace(/\.db$/i, ""))
      .sort()
      .reverse();
  } catch (_) {
    return null;
  }
  for (const monthKey of monthKeys) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    const row = entry.db
      .prepare(
        `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
           FROM alarms WHERE id = ?`,
      )
      .get(id);
    if (row) return row;
  }
  return null;
}

// v2.11.1 — audit_log archive-aware range reader. Merges hot DB with every
// monthly archive shard whose [s,e] overlaps the query window. Mirrors
// queryAlarmsRangeArchiveAware exactly so the same retention-deletion
// behaviour that broke alarms (rows vanishing from /api/audit when an
// operator-tightened auditRetainDays kicked in) can no longer recur.
// Caller-supplied `limit` is applied AFTER the merge so an old+new union
// still respects the response cap.
function auditNaturalKey(row) {
  return Number(row?.id || 0);
}
function sortAuditDesc(a, b) {
  return (
    Number(b?.ts || 0) - Number(a?.ts || 0) ||
    Number(b?.id || 0) - Number(a?.id || 0)
  );
}
function queryAuditRangeArchiveAware(startTs, endTs, { inverter, limit } = {}) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const invNum = Math.trunc(Number(inverter || 0));
  const hasInv = Number.isFinite(invNum) && invNum > 0;
  const cap = Math.max(1, Math.min(20000, Math.trunc(Number(limit) || 5000)));
  const out = new Map();
  // Hot first so the newest rows seed the map; archive rows fill in older
  // months without overwriting (pushUniqueRows is first-write-wins).
  pushUniqueRows(
    out,
    hasInv
      ? db
          .prepare(
            `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
               FROM audit_log WHERE inverter=? AND ts BETWEEN ? AND ?
               ORDER BY ts DESC LIMIT ?`,
          )
          .all(invNum, s, e, cap)
      : db
          .prepare(
            `SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
               FROM audit_log WHERE ts BETWEEN ? AND ?
               ORDER BY ts DESC LIMIT ?`,
          )
          .all(s, e, cap),
    auditNaturalKey,
  );
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(
      out,
      hasInv
        ? entry.selectAuditRangeByInv.all(invNum, s, e)
        : entry.selectAuditRangeAll.all(s, e),
      auditNaturalKey,
    );
  }
  return Array.from(out.values()).sort(sortAuditDesc).slice(0, cap);
}

function queryAlarmsRangeArchiveAware(startTs, endTs, { inverter, limit } = {}) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const invNum = Math.trunc(Number(inverter || 0));
  const hasInv = Number.isFinite(invNum) && invNum > 0;
  const cap = Math.max(1, Math.min(20000, Math.trunc(Number(limit) || 2000)));
  const out = new Map();
  // Hot first so the newest rows seed the map; archive rows then fill in
  // older months without overwriting (pushUniqueRows is first-write-wins).
  pushUniqueRows(
    out,
    hasInv
      ? db
          .prepare(
            `SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity, cleared_ts, acknowledged, updated_ts, stop_reason_id
               FROM alarms WHERE inverter=? AND ts BETWEEN ? AND ?
               ORDER BY ts DESC LIMIT ?`,
          )
          .all(invNum, s, e, cap)
      : stmts.getAlarmsRange.all(s, e),
    alarmsNaturalKey,
  );
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(
      out,
      hasInv
        ? entry.selectAlarmsRangeByInv.all(invNum, s, e)
        : entry.selectAlarmsRangeAll.all(s, e),
      alarmsNaturalKey,
    );
  }
  return Array.from(out.values()).sort(sortAlarmsDesc).slice(0, cap);
}

// Archive-aware distinct-bucket count over a HALF-OPEN [startTs, endTs)
// window. Used by the counter-baseline crash detector so a day whose
// readings have already been rotated into a month archive is not mistaken
// for "no data" (which would falsely trip crash_detected and reseed
// kwh_today from the hardware baseline). Reuses getArchiveEntry(key,false)
// exactly like the other range readers — LRU + replace-lock + eviction
// stay authoritative; no raw archive handle is opened here.
function countDistinctReadingBuckets(startTs, endTs, slotMs) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  const slot = Math.max(1, Math.trunc(Number(slotMs || 0)));
  if (!(e > s)) return 0;
  const buckets = new Set();
  // iterateMonthKeys uses BETWEEN-style inclusive bounds; the per-shard SQL
  // re-applies the exact half-open [s,e) filter so month selection being
  // slightly wide is harmless.
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    for (const row of entry.selectReadingBucketsRange.all(slot, s, e)) {
      buckets.add(Number(row.b));
    }
  }
  for (const row of stmts.selectReadingBucketsRange.all(slot, s, e)) {
    buckets.add(Number(row.b));
  }
  return buckets.size;
}

// Latest local YYYY-MM-DD that has raw `readings`, checking the hot DB first
// (newest telemetry always lands hot — archiving only moves data OLDER than
// the retention cutoff) and falling back to the newest month archive when
// the hot table has been fully pruned (plant down longer than retainDays).
// Used as the last-resort fallback in getLatestReportDate so report-date
// discovery still works off archived-only history after a long outage.
function getLatestReadingDate() {
  try {
    const hot = stmts.selectMaxReadingTs.get();
    const hotMax = Number(hot?.m || 0);
    if (hotMax > 0) return localDateStr(hotMax);
  } catch (_) {
    // fall through to archive scan
  }
  try {
    const monthKeys = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((name) => /^\d{4}-\d{2}\.db$/.test(name))
      .map((name) => name.replace(/\.db$/i, ""))
      .sort()
      .reverse(); // newest month first
    for (const monthKey of monthKeys) {
      const entry = getArchiveEntry(monthKey, false);
      if (!entry) continue;
      const row = entry.selectMaxReadingTs.get();
      const maxTs = Number(row?.m || 0);
      if (maxTs > 0) return localDateStr(maxTs);
    }
  } catch (_) {
    // no archives readable
  }
  return "";
}

// v2.10.4 — chunked source enumeration for export paths.
// Returns an ordered list of "sources" so callers can iterate one storage
// shard at a time and yield to the event loop between shards. Each source
// exposes a `.run()` thunk that performs a single synchronous `.all()` for
// just that shard. Splitting the read this way keeps each blocking SQL
// burst bounded to one archive (or the live DB), which lets the poller
// flush its persist backlog and the WebSocket loop service ticks during
// long Energy / 5-minute / Inverter Data exports.
//
// Caller pattern (see server/exporter.js buildEnergySummaryExportRows):
//   for (const src of listReadingsRangeSources(s, e, inverter)) {
//     await yieldToEventLoop();
//     const rows = src.run();
//     // bucket / process rows, yielding inside the loop
//   }
function listReadingsRangeSources(startTs, endTs, inverter = null) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const inv = inverter == null || inverter === '' ? null : Number(inverter);
  const sources = [];
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    sources.push({
      kind: 'archive',
      monthKey,
      run: () => (inv && inv > 0
        ? entry.selectReadingsRangeByInv.all(inv, s, e)
        : entry.selectReadingsRangeAll.all(s, e)),
    });
  }
  sources.push({
    kind: 'main',
    monthKey: null,
    run: () => (inv && inv > 0
      ? stmts.getReadingsRange.all(inv, s, e)
      : stmts.getReadingsRangeAll.all(s, e)),
  });
  return sources;
}

function listEnergy5minRangeSources(startTs, endTs, inverter = null) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const inv = inverter == null || inverter === '' ? null : Number(inverter);
  const sources = [];
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    sources.push({
      kind: 'archive',
      monthKey,
      run: () => (inv && inv > 0
        ? entry.selectEnergyRangeByInv.all(inv, s, e)
        : entry.selectEnergyRangeAll.all(s, e)),
    });
  }
  sources.push({
    kind: 'main',
    monthKey: null,
    run: () => (inv && inv > 0
      ? stmts.get5minRange.all(inv, s, e)
      : stmts.get5minRangeAll.all(s, e)),
  });
  return sources;
}

function queryEnergy5minRangeAll(startTs, endTs) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  // Note: v2.8.2's 500k "E4" guard removed — see queryReadingsRangeAll for
  // rationale. Route-level 366-day cap bounds the worst case.
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectEnergyRangeAll.all(s, e), energyNaturalKey);
    if (out.size > ENERGY5MIN_RANGE_MAX_ROWS) {
      throw _rangeRowCapError("energy_5min", out.size, ENERGY5MIN_RANGE_MAX_ROWS, "ADSI_ENERGY5MIN_RANGE_MAX_ROWS");
    }
  }
  pushUniqueRows(out, stmts.get5minRangeAll.all(s, e), energyNaturalKey);
  if (out.size > ENERGY5MIN_RANGE_MAX_ROWS) {
    throw _rangeRowCapError("energy_5min", out.size, ENERGY5MIN_RANGE_MAX_ROWS, "ADSI_ENERGY5MIN_RANGE_MAX_ROWS");
  }
  return Array.from(out.values()).sort(sortEnergyAsc);
}

function queryEnergy5minRange(inverter, startTs, endTs) {
  const inv = Number(inverter || 0);
  if (!(inv > 0)) return [];
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  if (!(e >= s)) return [];
  const out = new Map();
  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    pushUniqueRows(out, entry.selectEnergyRangeByInv.all(inv, s, e), energyNaturalKey);
  }
  pushUniqueRows(out, stmts.get5minRange.all(inv, s, e), energyNaturalKey);
  return Array.from(out.values()).sort(sortEnergyAsc);
}

function sumEnergy5minByInverterRange(startTs, endTs, inverter = null) {
  const s = Number(startTs || 0);
  const e = Number(endTs || 0);
  const inv = Number(inverter || 0);
  const out = new Map();
  if (!(e >= s)) return out;

  function addSumRows(rows) {
    for (const row of rows || []) {
      const key = Number(row?.inverter || 0);
      if (!(key > 0)) continue;
      out.set(key, Number(out.get(key) || 0) + Number(row?.total_kwh || 0));
    }
  }

  for (const monthKey of iterateMonthKeys(s, e)) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    addSumRows(
      inv > 0
        ? entry.sumEnergyRangeByInv.all(inv, s, e)
        : entry.sumEnergyRangeAll.all(s, e),
    );
  }

  addSumRows(
    inv > 0
      ? stmts.sumEnergy5minRangeByInv.all(inv, s, e)
      : stmts.sumEnergy5minRange.all(s, e),
  );

  return out;
}

// ─── Tier 0.1: startup recovery of today's lost energy slots ────────────────
// audits/2026-05-30/energy-logging-integrity-hardening.md
//
// energy_5min is committed only at 5-min slot rollover (poller.update5minBucket),
// so the in-progress slot lives only in memory until the boundary crosses. A
// freeze that ends in a hard kill loses that slot plant-wide: the event loop is
// frozen, so the graceful partial-flush in poller.flushPending() can never run.
// But the raw `readings` rows for the slot were persisted at ~1 s cadence and
// survive. This re-integrates PAC from those readings into any COMPLETED today
// slot that is missing from energy_5min, before the poller resumes live
// integration — turning a permanent plant-wide gap into a self-heal on restart.
//
// Safety properties (see audit §4 / §6):
//   • Today-only + hot-DB-only (today is never archived same-day) → bounded, so a
//     synchronous read at boot is fine; it runs once, before the server serves.
//   • COMPLETED slots only (bucketTs < the current 5-min slot). The in-progress
//     slot is owned by the live poller and never touched here → no duplicate-row
//     or double-count race with the live writer (energy_5min has no UNIQUE).
//   • Idempotent: only (inverter, slot_ts) pairs NOT already present are written,
//     so re-running (e.g. a remote→gateway switch later in the day) is a no-op
//     for already-covered slots.
//   • PAC trapezoid with the same 30 s dt cap as buildPacEnergyBuckets and the
//     live integrator → a gap in readings (the freeze window) adds no energy, so
//     there is no counter catch-up spike and no classifyBucketInc() clamp needed.
//   • Caller is the gateway branch of applyRuntimeMode() only → never in remote.
function recoverTodayEnergyFromReadings(nowTs = Date.now()) {
  const now = Number(nowTs) || Date.now();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const dayStart = startOfDay.getTime();
  const FIVE_MIN = 5 * 60 * 1000;
  const currentSlotStart = Math.floor(now / FIVE_MIN) * FIVE_MIN;
  // No fully-elapsed slot yet today (within the first 5 min after midnight).
  if (!(currentSlotStart > dayStart)) return { recovered: 0, kwh: 0, inverters: 0 };
  const windowEnd = currentSlotStart - 1; // inclusive BETWEEN upper bound
  // Defense-in-depth (adversarial review nit): the recovery window must end
  // strictly before the in-progress slot. This holds by construction today, but
  // a future change to FIVE_MIN / the floor logic must never let recovery reach
  // the slot the live poller is about to own.
  if (!(windowEnd < currentSlotStart)) return { recovered: 0, kwh: 0, inverters: 0 };

  // 1) Integrate PAC from persisted readings into per-(inverter, slot) kWh.
  //    Mirrors buildPacEnergyBuckets exactly (online-gated, 30 s dt cap, summed
  //    across a node's units into one per-inverter bucket). getReadingsRangeAll
  //    orders by inverter,unit,ts so each node's samples arrive ts-ascending.
  let readingRows;
  try {
    readingRows = stmts.getReadingsRangeAll.all(dayStart, windowEnd);
  } catch (err) {
    console.warn("[energy-recovery] readings read failed:", err?.message || err);
    return { recovered: 0, kwh: 0, inverters: 0 };
  }
  if (!readingRows || !readingRows.length) return { recovered: 0, kwh: 0, inverters: 0 };

  const dtCapSec = 30;
  const nodeState = new Map(); // `${inv}_${unit}` -> { ts, pac }
  const bucketMap = new Map(); // `${inv}|${bucketTs}` -> kwh
  for (const r of readingRows) {
    const inv = Number(r?.inverter || 0);
    const unit = Number(r?.unit || 0);
    const ts = Number(r?.ts || 0);
    if (!inv || !unit || !ts) continue;
    const key = `${inv}_${unit}`;
    const online = Number(r?.online || 0) === 1;
    const pacW = Math.max(0, Number(online ? r?.pac : 0) || 0);
    const prev = nodeState.get(key);
    if (prev && ts > prev.ts) {
      const dtSecRaw = (ts - prev.ts) / 1000;
      if (dtSecRaw > 0) {
        const dtSec = Math.min(dtCapSec, dtSecRaw);
        const avgPac = (Number(prev.pac || 0) + pacW) / 2;
        const kwhInc = (avgPac * dtSec) / 3600000; // W*s -> kWh
        if (kwhInc > 0) {
          const bucketTs = Math.floor(ts / FIVE_MIN) * FIVE_MIN;
          const bKey = `${inv}|${bucketTs}`;
          bucketMap.set(bKey, Number(bucketMap.get(bKey) || 0) + kwhInc);
        }
      }
    }
    nodeState.set(key, { ts, pac: pacW });
  }
  if (!bucketMap.size) return { recovered: 0, kwh: 0, inverters: 0 };

  // 2) (inverter, slot_ts) pairs already present in energy_5min for the window.
  const existing = new Set();
  try {
    for (const er of stmts.get5minRangeAll.all(dayStart, windowEnd)) {
      existing.add(`${Number(er.inverter)}|${Number(er.ts)}`);
    }
  } catch (err) {
    console.warn("[energy-recovery] energy_5min read failed:", err?.message || err);
    return { recovered: 0, kwh: 0, inverters: 0 };
  }

  // 3) Insert only the missing slots (idempotent), in one transaction.
  const toInsert = [];
  for (const [bKey, kwh] of bucketMap.entries()) {
    if (existing.has(bKey)) continue; // already logged — never double-write
    const kwhInc = Number(Number(kwh || 0).toFixed(6));
    if (!(kwhInc > 0)) continue;
    const [invStr, tsStr] = bKey.split("|");
    toInsert.push({ inverter: Number(invStr), ts: Number(tsStr), kwh_inc: kwhInc });
  }
  if (!toInsert.length) return { recovered: 0, kwh: 0, inverters: 0 };

  let totalKwh = 0;
  const insertTx = db.transaction((rows) => {
    for (const row of rows) {
      stmts.insertEnergy5.run(row.ts, row.inverter, row.kwh_inc);
      totalKwh += row.kwh_inc;
    }
  });
  try {
    insertTx(toInsert);
  } catch (err) {
    console.error("[energy-recovery] insert failed:", err?.message || err);
    return { recovered: 0, kwh: 0, inverters: 0 };
  }

  totalKwh = Number(totalKwh.toFixed(6));
  const inverters = new Set(toInsert.map((r) => r.inverter)).size;
  try {
    insertAuditLogRow({
      ts: now,
      operator: "SYSTEM",
      action: "energy_slot_recovery",
      scope: "plant",
      result: "warn",
      reason:
        `Startup recovery re-integrated ${toInsert.length} missing completed energy_5min ` +
        `slot(s) (${totalKwh.toFixed(3)} kWh) across ${inverters} inverter(s) from persisted ` +
        `readings — energy that was unflushed when a prior session ended without a graceful ` +
        `shutdown (freeze / hard-kill / power-loss). PAC-integrated, 30 s dt cap, today-only.`,
    });
  } catch (err) {
    console.warn("[energy-recovery] audit row failed:", err?.message || err);
  }

  console.log(
    `[energy-recovery] backfilled ${toInsert.length} energy_5min slot(s), ` +
    `${totalKwh.toFixed(3)} kWh across ${inverters} inverter(s) from persisted readings.`,
  );
  return { recovered: toInsert.length, kwh: totalKwh, inverters };
}

function rebuildDailyReadingsSummaryForDate(dayInput) {
  const day = String(dayInput || "").trim();
  if (!day) return [];
  const startTs = new Date(`${day}T00:00:00.000`).getTime();
  const endTs = new Date(`${day}T23:59:59.999`).getTime();
  const rows = annotateRowsWithComputedKwh(queryReadingsRangeAll(startTs, endTs));
  const states = new Map();
  for (const row of rows) {
    const inverter = Number(row?.inverter || 0);
    const unit = Number(row?.unit || 0);
    if (!(inverter > 0) || !(unit > 0)) continue;
    const key = `${day}|${inverter}|${unit}`;
    let state = states.get(key);
    if (!state) {
      state = createSummaryState(day, inverter, unit);
      states.set(key, state);
    }
    applyReadingToSummaryState(state, row);
  }
  const now = Date.now();
  const payloads = Array.from(states.values()).map((state) => summaryStateToPayload(state, now));
  writeSummaryPayloadsTx(payloads, day);
  return getDailyReadingsSummaryRows(day);
}
const deleteReadingById = db.prepare(`DELETE FROM readings WHERE id=?`);
const deleteEnergy5ById = db.prepare(`DELETE FROM energy_5min WHERE id=?`);
const deleteAlarmById = db.prepare(`DELETE FROM alarms WHERE id=?`);
const deleteAuditById = db.prepare(`DELETE FROM audit_log WHERE id=?`);
const deleteStopReasonById = db.prepare(`DELETE FROM inverter_stop_reasons WHERE id=?`);
const deleteReadingsBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteReadingById.run(id);
});
const deleteEnergyBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteEnergy5ById.run(id);
});
const deleteAlarmsBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteAlarmById.run(id);
});
const deleteAuditBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteAuditById.run(id);
});
const deleteStopReasonsBatchTx = db.transaction((ids) => {
  for (const id of ids || []) deleteStopReasonById.run(id);
});
const selectOldReadingsBatch = db.prepare(`
  SELECT id, ts, inverter, unit, pac, kwh, alarm, online
    FROM readings
   WHERE ts < ?
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
const selectOldEnergyBatch = db.prepare(`
  SELECT id, ts, inverter, kwh_inc
    FROM energy_5min
   WHERE ts < ?
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
// v2.11.0-beta.10 — only CLEARED alarms (cleared_ts IS NOT NULL) are eligible
// for archival. Active (unresolved) alarms always stay in the hot DB regardless
// of age so the alarm-log UI surfaces them immediately. This matches the
// previous DELETE filter at pruneOldData(); the only behavioural change is
// that the rows now end up in `db/archive/<YYYY-MM>.db` instead of being
// permanently lost.
const selectOldAlarmsBatch = db.prepare(`
  SELECT id, ts, inverter, unit, alarm_code, alarm_value, severity,
         cleared_ts, acknowledged, updated_ts, stop_reason_id
    FROM alarms
   WHERE ts < ? AND cleared_ts IS NOT NULL
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
// v2.11.1 — audit_log archive selector. Audit rows are immutable once
// inserted (no UPDATE path) so every row older than the cutoff is eligible.
// Mirrors selectOldReadingsBatch / selectOldAlarmsBatch — same chunked
// pattern, same column projection as the archive shard insert.
const selectOldAuditBatch = db.prepare(`
  SELECT id, ts, operator, inverter, node, action, scope, result, ip, reason
    FROM audit_log
   WHERE ts < ?
   ORDER BY ts ASC, id ASC
   LIMIT ?
`);
// v2.11.1-beta.1 — stop_reasons archive selector. Snapshot rows are
// immutable (no UPDATE path). Cutoff is read_at_ms (NOT ts). The same
// chunked pattern as the audit / alarms selectors so the prune loop yields
// the event-loop between batches.
const selectOldStopReasonsBatch = db.prepare(`
  SELECT id, inverter_id, inverter_ip, slave, node,
         read_at_ms, event_at_ms, trigger_source, alarm_id,
         pot_ac, vpv, vac1, vac2, vac3, iac1, iac2,
         frec1, frec2, frec3, cos, temp,
         alarma, motparo, motparo_label,
         alarmas1, alarmas2, flags,
         ref1, pos1, ref2, pos2,
         timeout_band, debug_desc,
         struct_month, struct_day, struct_hour, struct_min,
         raw_hex, fingerprint, updated_ts
    FROM inverter_stop_reasons
   WHERE read_at_ms < ?
   ORDER BY read_at_ms ASC, id ASC
   LIMIT ?
`);

function archiveRowsByMonth(rows, type) {
  const groups = new Map();
  // v2.11.1-beta.1 — different archive row types key on different columns.
  // Most use numeric ts; stop_reasons uses read_at_ms. The dispatch table
  // picks the right extractor so shards stay consistent with the hot row's
  // natural time column.
  const monthKeyFn =
    type === "stop_reasons" ? (row) => monthKeyFromTs(row?.read_at_ms) :
                              (row) => monthKeyFromTs(row?.ts);
  for (const row of rows || []) {
    const monthKey = monthKeyFn(row);
    if (!groups.has(monthKey)) groups.set(monthKey, []);
    groups.get(monthKey).push(row);
  }
  for (const [monthKey, groupedRows] of groups.entries()) {
    const entry = getArchiveEntry(monthKey, true);
    if (!entry) throw new Error(`Archive DB open failed for month ${monthKey}`);
    if (type === "readings") entry.insertReadingsTx(groupedRows);
    else if (type === "energy") entry.insertEnergyTx(groupedRows);
    else if (type === "alarms") entry.insertAlarmsTx(groupedRows);
    else if (type === "audit") entry.insertAuditTx(groupedRows);
    else if (type === "stop_reasons") entry.insertStopReasonsTx(groupedRows);
    else throw new Error(`Unknown archive row type: ${type}`);
  }
}

function archiveReadingsRows(rows) {
  archiveRowsByMonth(rows, "readings");
}

function archiveEnergyRows(rows) {
  archiveRowsByMonth(rows, "energy");
}

// ─── Universal archive helper (v2.11.2) ─────────────────────────────────────
//
// Generic migrator for hot tables that previously DELETE'd on retention.
// Mirrors the hot-table schema dynamically (via sqlite_master.sql so even
// partial indexes / WITHOUT ROWID survive) so the archive shard absorbs
// every column — including the many ensureColumn() additions on
// inverter_5min_param — without a static DDL drift bug.
//
// The helper opens (or creates) the monthly archive shard for each row,
// CREATEs the table there if missing, ALTER ADD COLUMNs any new columns
// the hot side has gained since the shard was last touched, INSERT OR
// IGNOREs the rows, then DELETEs them from hot — exactly the same
// archive-then-delete contract as ARCHIVE_READING_TABLE_DDL / alarms /
// audit / stop_reasons, but expressed once instead of per-table.
//
// Row identity for delete is `rowid` for default tables; for WITHOUT ROWID
// tables (inverter_5min_param, igbt_thermal_baseline) the compound PK is
// used. The probe + schema discovery is cached per tableName, so the only
// per-call SQLite work is the batched SELECT / INSERT / DELETE.
//
// Concurrency / freeze prevention (v2.11.2 hardening):
//   - Per-table single-flight gate (_ARCHIVE_RUNNING_LOCK): if a second
//     caller invokes archive on the same table while the first is still
//     running, the second returns 0 immediately. Different tables can
//     still archive in parallel.
//   - Per-call batch ceiling (ARCHIVE_MAX_BATCHES_PER_CALL): when first
//     deploying this fix on a long-idle gateway, the first sweep might
//     have months of backlog. The ceiling caps the wall-clock at
//     ~ ARCHIVE_MAX_BATCHES_PER_CALL × (batch select+insert+delete +
//     event-loop yield) — typically under 30 s — so a single invocation
//     never holds the foreground busy for minutes. The next cron tick
//     continues from where this one stopped.
//   - Schema / statement caches keyed by tableName + (monthKey, tableName)
//     so PRAGMA / sqlite_master lookups happen exactly once per process
//     per table, and INSERT prepared statements stay hot inside the
//     archive entry across batches.
const ARCHIVE_GENERIC_SCHEMA_CACHE = new Map();   // monthKey → Set<tableName>
const ARCHIVE_HOT_SCHEMA_CACHE = new Map();      // tableName → { cols, ... }
const ARCHIVE_HOT_STMT_CACHE = new Map();        // tableName → { selectStmt, deleteStmt, deleteBatchTx }
const ARCHIVE_PER_SHARD_INSERT_CACHE = new Map(); // `${monthKey}|${tableName}` → preparedStmt
const ARCHIVE_RUNNING_LOCK = new Set();          // tableName currently being archived
// Bound the wall-clock of a single archive invocation. 100 batches ×
// 2000 rows = 200_000 rows per sweep; at ~50ms per batch + yield, the
// whole call stays under ~ 20s. On a long backlog the remaining rows
// drain over subsequent cron ticks.
const ARCHIVE_MAX_BATCHES_PER_CALL = 100;

function _readPragmaTableInfo(database, tableName) {
  try {
    return database.prepare(`PRAGMA table_info("${tableName}")`).all();
  } catch (_) {
    return [];
  }
}

function _readSqliteMasterSql(database, type, name) {
  try {
    const row = database
      .prepare(`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`)
      .get(String(type || ""), String(name || ""));
    return row && typeof row.sql === "string" ? row.sql : "";
  } catch (_) {
    return "";
  }
}

function _isWithoutRowidFromMaster(tableSql) {
  // Definitive — string match against the CREATE TABLE DDL. Avoids a
  // SELECT roundtrip on every archive call.
  return /\)\s*WITHOUT\s+ROWID\s*;?\s*$/i.test(String(tableSql || ""));
}

function _readHotSchemaCached(tableName) {
  const cached = ARCHIVE_HOT_SCHEMA_CACHE.get(tableName);
  if (cached) return cached;
  const cols = _readPragmaTableInfo(db, tableName);
  if (!cols.length) {
    // Don't cache a miss — table may not exist yet (created later by
    // an ensureColumn or migration). Future calls will retry.
    return null;
  }
  const colNames = cols.map((c) => c.name);
  const pkColNames = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  const tableSql = _readSqliteMasterSql(db, "table", tableName);
  const isWithoutRowid = _isWithoutRowidFromMaster(tableSql);
  const colList = colNames.map((n) => `"${n}"`).join(", ");
  const insertPlaceholders = colNames.map((n) => `@${n}`).join(", ");
  const entry = {
    cols,
    colNames,
    pkColNames,
    isWithoutRowid,
    colList,
    insertPlaceholders,
    tableSql,
  };
  ARCHIVE_HOT_SCHEMA_CACHE.set(tableName, entry);
  return entry;
}

function _readHotStmtsCached(tableName, cutoffColumn, schema) {
  const key = `${tableName}|${cutoffColumn}`;
  const cached = ARCHIVE_HOT_STMT_CACHE.get(key);
  if (cached) return cached;
  const { colList, isWithoutRowid, pkColNames } = schema;
  const selectStmt = db.prepare(
    isWithoutRowid
      ? `SELECT ${colList} FROM "${tableName}"
           WHERE "${cutoffColumn}" < ?
           ORDER BY "${cutoffColumn}" ASC
           LIMIT ?`
      : `SELECT rowid AS __rid, ${colList} FROM "${tableName}"
           WHERE "${cutoffColumn}" < ?
           ORDER BY "${cutoffColumn}" ASC
           LIMIT ?`,
  );
  const deleteStmt = db.prepare(
    isWithoutRowid
      ? `DELETE FROM "${tableName}" WHERE ${pkColNames
          .map((n) => `"${n}" = ?`)
          .join(" AND ")}`
      : `DELETE FROM "${tableName}" WHERE rowid = ?`,
  );
  const deleteBatchTx = db.transaction((idents) => {
    for (const ident of idents || []) {
      if (Array.isArray(ident)) deleteStmt.run(...ident);
      else deleteStmt.run(ident);
    }
  });
  const entry = { selectStmt, deleteStmt, deleteBatchTx };
  ARCHIVE_HOT_STMT_CACHE.set(key, entry);
  return entry;
}

function ensureArchiveTableSchema(archiveDb, monthKey, tableName, schema) {
  // Per (monthKey, tableName) cache so we touch PRAGMA exactly once per
  // open archive entry. The Map is cleared whenever the LRU evicts an
  // archive entry (see closeArchiveDbForMonth below).
  let perMonth = ARCHIVE_GENERIC_SCHEMA_CACHE.get(monthKey);
  if (!perMonth) {
    perMonth = new Set();
    ARCHIVE_GENERIC_SCHEMA_CACHE.set(monthKey, perMonth);
  }
  if (perMonth.has(tableName)) return;

  const hotCols = schema?.cols || _readPragmaTableInfo(db, tableName);
  if (!hotCols.length) {
    perMonth.add(tableName);
    return;
  }

  // Prefer the verbatim CREATE TABLE from sqlite_master (preserves WITHOUT
  // ROWID, composite PK ordering, etc.). Fall back to a reconstructed DDL
  // only if sqlite_master is unavailable (shouldn't happen in production).
  const hotTableSql = schema?.tableSql || _readSqliteMasterSql(db, "table", tableName);
  let createTableSql = "";
  if (hotTableSql) {
    // Strip NOT NULL + DEFAULT clauses for two safety reasons:
    //   1. Archive INSERTs replay row contents verbatim from the hot side,
    //      so a NULL where a NOT NULL was declared can appear (e.g. column
    //      was added later via ensureColumn before any NOT NULL backfill).
    //   2. DEFAULT (CAST((julianday('now')...) AS INTEGER)) clauses would
    //      generate fresh values on archive INSERT, hiding the original
    //      hot timestamp — but we always provide the explicit value.
    let stripped = String(hotTableSql);
    while (/\bDEFAULT\s*\(/i.test(stripped)) {
      const match = stripped.search(/\bDEFAULT\s*\(/i);
      const startParen = stripped.indexOf("(", match);
      let depth = 1;
      let i = startParen + 1;
      while (i < stripped.length && depth > 0) {
        if (stripped[i] === "(") depth++;
        else if (stripped[i] === ")") depth--;
        i++;
      }
      stripped = stripped.slice(0, match) + stripped.slice(i);
    }
    createTableSql = stripped
      .replace(/\bNOT\s+NULL\b/gi, "")
      .replace(/\bDEFAULT\s+[^,)\s]+/gi, "")
      .replace(/\bAUTOINCREMENT\b/gi, "")
      .replace(/^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?[\w]+"?/i,
        `CREATE TABLE IF NOT EXISTS "${tableName}"`);
  } else {
    // Defensive fallback (sqlite_master miss): reconstruct from PRAGMA.
    const pkCols = hotCols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk);
    const singleIntPk = pkCols.length === 1 && /INT/i.test(pkCols[0].type || "");
    const lines = hotCols.map((c) => {
      const type = c.type || "";
      if (singleIntPk && c.name === pkCols[0].name) {
        return `"${c.name}" ${type || "INTEGER"} PRIMARY KEY`;
      }
      return `"${c.name}" ${type}`.trim();
    });
    if (pkCols.length > 1) {
      lines.push(`PRIMARY KEY (${pkCols.map((c) => `"${c.name}"`).join(", ")})`);
    }
    createTableSql = `CREATE TABLE IF NOT EXISTS "${tableName}" (${lines.join(", ")})`;
  }
  try {
    archiveDb.exec(createTableSql);
  } catch (err) {
    // Surfaced loudly — a malformed CREATE TABLE is a real bug worth
    // catching in logs even though we continue (archive shard may already
    // have the table from a previous version).
    console.warn(`[archive] CREATE TABLE failed for ${tableName} in ${monthKey}:`, err.message);
  }

  // Backfill any columns the hot table has gained since the shard was last
  // touched (ensureColumn migrations on the hot side).
  const archCols = _readPragmaTableInfo(archiveDb, tableName);
  const archNames = new Set(archCols.map((c) => c.name));
  for (const c of hotCols) {
    if (archNames.has(c.name)) continue;
    try {
      archiveDb.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${c.name}" ${c.type || ""}`.trim());
    } catch (_) {
      // ignore — ALTER may race with another writer; retry next sweep.
    }
  }

  // Mirror non-PK indexes by reading the verbatim CREATE INDEX SQL from
  // sqlite_master (preserves WHERE clauses for partial indexes like
  // idx_p5m_solar). PRAGMA index_list + index_info would lose the partial
  // predicate, leaving the archive with a non-partial index that wastes
  // space without the same query selectivity.
  let idxRows = [];
  try {
    idxRows = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
           WHERE type = 'index' AND tbl_name = ?
             AND sql IS NOT NULL
             AND name NOT LIKE 'sqlite_autoindex_%'`,
      )
      .all(tableName);
  } catch (_) {
    idxRows = [];
  }
  for (const r of idxRows) {
    const sql = String(r?.sql || "");
    if (!sql) continue;
    const safeSql = sql.replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
      (m, u) => `CREATE ${u ? "UNIQUE " : ""}INDEX IF NOT EXISTS `);
    try {
      archiveDb.exec(safeSql);
    } catch (_) {
      // Best-effort: archive shard read paths still work via table scan.
    }
  }

  perMonth.add(tableName);
}

function _monthKeyFor(value, kind) {
  if (kind === "date_string") {
    // "YYYY-MM-DD..." → "YYYY-MM". Fallback to current month so an
    // unexpectedly malformed date_local string still archives instead
    // of throwing.
    const s = String(value || "").slice(0, 7);
    return /^\d{4}-\d{2}$/.test(s) ? s : monthKeyFromTs(Date.now());
  }
  return monthKeyFromTs(Number(value || 0));
}

function _getArchiveInsertStmt(entry, monthKey, tableName, schema) {
  const key = `${monthKey}|${tableName}`;
  const cached = ARCHIVE_PER_SHARD_INSERT_CACHE.get(key);
  if (cached) return cached;
  const { colList, insertPlaceholders } = schema;
  const stmt = entry.db.prepare(
    `INSERT OR IGNORE INTO "${tableName}" (${colList}) VALUES (${insertPlaceholders})`,
  );
  ARCHIVE_PER_SHARD_INSERT_CACHE.set(key, stmt);
  return stmt;
}

// archiveTableBeforeCutoff({ tableName, cutoffColumn, cutoffValue,
//   monthKeyColumn, monthKeyKind: 'ms' | 'date_string',
//   maxBatches: number (default ARCHIVE_MAX_BATCHES_PER_CALL) })
//
// Returns the number of rows migrated. Yields the event loop between
// batches (ARCHIVE_BATCH_SIZE rows) so polling, WS, and HTTP requests
// continue to make progress while a backlog drains. Bounded by
// `maxBatches` so no single call can run for more than ~20 s — the next
// cron tick continues with the remaining rows.
async function archiveTableBeforeCutoff({
  tableName,
  cutoffColumn,
  cutoffValue,
  monthKeyColumn,
  monthKeyKind = "ms",
  maxBatches = ARCHIVE_MAX_BATCHES_PER_CALL,
} = {}) {
  if (!tableName || !cutoffColumn || !monthKeyColumn) return 0;
  if (cutoffValue == null) return 0;

  // Per-table single-flight. Prevents overlapping crons (21:30 pruneOldData
  // + 21:35 history-prune + 6h dailyAgg) from racing on the same shard.
  if (ARCHIVE_RUNNING_LOCK.has(tableName)) return 0;

  const schema = _readHotSchemaCached(tableName);
  if (!schema) return 0;
  const { colNames, pkColNames, isWithoutRowid } = schema;

  if (isWithoutRowid && !pkColNames.length) {
    // No way to safely delete a single row — refuse rather than risk
    // dropping the wrong row.
    console.warn(`[archive] ${tableName} WITHOUT ROWID but no PK — skipping`);
    return 0;
  }

  ARCHIVE_RUNNING_LOCK.add(tableName);
  try {
    const { selectStmt, deleteBatchTx } = _readHotStmtsCached(
      tableName,
      cutoffColumn,
      schema,
    );

    let migrated = 0;
    let batchCount = 0;
    while (batchCount < maxBatches) {
      const rows = selectStmt.all(cutoffValue, ARCHIVE_BATCH_SIZE);
      if (!rows.length) break;
      batchCount += 1;

      const groups = new Map();
      for (const row of rows) {
        const monthKey = _monthKeyFor(row[monthKeyColumn], monthKeyKind);
        if (!groups.has(monthKey)) groups.set(monthKey, []);
        groups.get(monthKey).push(row);
      }

      for (const [monthKey, grp] of groups.entries()) {
        const entry = getArchiveEntry(monthKey, true);
        if (!entry) throw new Error(`Archive DB open failed for month ${monthKey}`);
        ensureArchiveTableSchema(entry.db, monthKey, tableName, schema);
        const insertStmt = _getArchiveInsertStmt(entry, monthKey, tableName, schema);
        const insTx = entry.db.transaction((batch) => {
          for (const r of batch) {
            // Drop synthetic __rid before binding so SQLite doesn't complain
            // about an extra named parameter.
            const clean = {};
            for (const n of colNames) clean[n] = r[n];
            insertStmt.run(clean);
          }
        });
        insTx(grp);
      }

      const idents = isWithoutRowid
        ? rows.map((r) => pkColNames.map((n) => r[n]))
        : rows.map((r) => Number(r.__rid || 0)).filter((v) => v > 0);
      deleteBatchTx(idents);
      migrated += rows.length;
      await _yieldEventLoop();
    }
    if (batchCount >= maxBatches) {
      console.log(
        `[archive] ${tableName} hit per-call batch cap (${batchCount} × ${ARCHIVE_BATCH_SIZE}); next sweep will continue`,
      );
    }
    return migrated;
  } finally {
    ARCHIVE_RUNNING_LOCK.delete(tableName);
  }
}

// Test-only helper: drop the in-process caches so an in-memory db swap
// (ABI-agnostic tests use a fresh better-sqlite3 :memory: per test)
// doesn't see stale prepared statements bound to a closed db handle.
function _resetArchiveCachesForTest() {
  ARCHIVE_HOT_SCHEMA_CACHE.clear();
  ARCHIVE_HOT_STMT_CACHE.clear();
  ARCHIVE_PER_SHARD_INSERT_CACHE.clear();
  ARCHIVE_GENERIC_SCHEMA_CACHE.clear();
  ARCHIVE_RUNNING_LOCK.clear();
}

function safeFileSize(filePath) {
  try {
    return Number(fs.statSync(filePath).size || 0);
  } catch (_) {
    return 0;
  }
}

function getArchiveDirStats() {
  const stats = { fileCount: 0, totalBytes: 0 };
  try {
    const entries = fs.readdirSync(ARCHIVE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.db$/i.test(entry.name)) continue;
      stats.fileCount += 1;
      stats.totalBytes += safeFileSize(path.join(ARCHIVE_DIR, entry.name));
    }
  } catch (_) {
    // Ignore archive stats failures during best-effort telemetry pruning.
  }
  return stats;
}

function checkpointArchiveDbs(mode = "TRUNCATE") {
  for (const entry of ARCHIVE_DB_CACHE.values()) {
    try {
      entry.db.pragma(`wal_checkpoint(${mode})`);
    } catch (_) {
      // Ignore archive checkpoint failures during routine maintenance.
    }
  }
}

function checkpointMainDb(mode = "TRUNCATE") {
  try {
    db.pragma(`wal_checkpoint(${mode})`);
    return true;
  } catch (err) {
    console.error("[DB] WAL checkpoint failed:", err.message);
    return false;
  }
}

function vacuumMainDb() {
  try {
    db.exec("VACUUM");
    return true;
  } catch (err) {
    console.error("[DB] VACUUM failed:", err.message);
    return false;
  }
}

function getTelemetryHotCutoffTs(now = Date.now()) {
  const retainDays = Math.max(1, Number(getSetting("retainDays", 90)));
  return Number(now || Date.now()) - retainDays * 24 * 60 * 60 * 1000;
}

function _yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function archiveTelemetryBeforeCutoff(cutoffTs) {
  const cutoff = Number(cutoffTs || 0);
  const stats = { readings: 0, energy5: 0, alarms: 0 };
  if (!(cutoff > 0)) return stats;

  while (true) {
    const rows = selectOldReadingsBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "readings");
    deleteReadingsBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.readings += rows.length;
    await _yieldEventLoop(); // let polling, WS, and HTTP continue between batches
  }

  while (true) {
    const rows = selectOldEnergyBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "energy");
    deleteEnergyBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.energy5 += rows.length;
    await _yieldEventLoop();
  }

  // v2.11.0-beta.10 — alarms archive shard. Replaces the unconditional
  // DELETE that pruneOldData() used to run (was permanently losing the
  // alarm log on operator-tightened retention like `retainDays=1`).
  // Active alarms (cleared_ts IS NULL) are NEVER pulled — they stay in
  // hot for the live alarm-log table. Only CLEARED rows older than the
  // cutoff migrate; the archive-aware /api/alarms reader re-merges them
  // for past-date queries.
  while (true) {
    const rows = selectOldAlarmsBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "alarms");
    deleteAlarmsBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    stats.alarms += rows.length;
    await _yieldEventLoop();
  }

  return stats;
}

// v2.11.1 — audit_log archive migrator (own cutoff, distinct from telemetry).
// Audit retention is controlled by `auditRetainDays` (default 365), separate
// from `retainDays` (default 90) — the operator typically keeps control-action
// history far longer than telemetry. Prior to v2.11.1 pruneOldData() ran an
// unconditional `DELETE FROM audit_log WHERE ts < auditCutoff` which is the
// same data-loss pattern the v2.11.0-beta.10 alarms work eliminated; if
// `auditRetainDays` ever shrunk (operator typo, stray DB write, future UI
// knob) every "who started/stopped what" record would evaporate. The archive
// migration mirrors the alarm path: chunked select → monthly-shard insert →
// hot-DB delete by id, with event-loop yields between batches.
async function archiveAuditBeforeCutoff(cutoffTs) {
  const cutoff = Number(cutoffTs || 0);
  let migrated = 0;
  if (!(cutoff > 0)) return migrated;
  while (true) {
    const rows = selectOldAuditBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "audit");
    deleteAuditBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    migrated += rows.length;
    await _yieldEventLoop();
  }
  return migrated;
}

// v2.11.1-beta.1 — stop_reasons archive migrator. Replaces the unconditional
// `DELETE FROM inverter_stop_reasons WHERE read_at_ms < ?` previously run
// inside stopReasons.pruneOldRows. Same pattern as alarms / audit: chunked
// select → monthly-shard insert → hot-DB delete by id, with event-loop
// yields between batches.
async function archiveStopReasonsBeforeCutoff(cutoffMs) {
  const cutoff = Number(cutoffMs || 0);
  let migrated = 0;
  if (!(cutoff > 0)) return migrated;
  while (true) {
    const rows = selectOldStopReasonsBatch.all(cutoff, ARCHIVE_BATCH_SIZE);
    if (!rows.length) break;
    archiveRowsByMonth(rows, "stop_reasons");
    deleteStopReasonsBatchTx(rows.map((row) => Number(row.id || 0)).filter((id) => id > 0));
    migrated += rows.length;
    await _yieldEventLoop();
  }
  return migrated;
}

// v2.11.1-beta.1 — single-row archive-aware lookup for stop_reasons.
// Used by the alarm-drilldown so when the alarm row has already been pulled
// from the alarm shard (alarms-archive resolves it), the joined StopReason
// snapshot resolves too — no orphan rows visible in the UI even though
// both tables have separately migrated to their archive shards.
function findStopReasonByIdArchiveAware(stopReasonId) {
  const id = Math.trunc(Number(stopReasonId || 0));
  if (!(id > 0)) return null;
  const hot = db.prepare(`SELECT * FROM inverter_stop_reasons WHERE id = ?`).get(id);
  if (hot) return hot;
  let monthKeys = [];
  try {
    monthKeys = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((name) => /^\d{4}-\d{2}\.db$/.test(name))
      .map((name) => name.replace(/\.db$/i, ""))
      .sort()
      .reverse();
  } catch (_) {
    return null;
  }
  for (const monthKey of monthKeys) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    const row = entry.selectStopReasonById.get(id);
    if (row) return row;
  }
  return null;
}

// v2.11.1-beta.1 — by-alarm-id archive-aware lookup for the backfill
// path (stopReasons.getEventByAlarmId). Same shard iteration as
// findStopReasonByIdArchiveAware but uses the alarm_id index on each
// archive shard so the lookup is O(log n) per month.
function findStopReasonByAlarmIdArchiveAware(alarmId) {
  const id = Math.trunc(Number(alarmId || 0));
  if (!(id > 0)) return null;
  const hot = db
    .prepare(
      `SELECT * FROM inverter_stop_reasons WHERE alarm_id = ?
         ORDER BY read_at_ms DESC LIMIT 1`,
    )
    .get(id);
  if (hot) return hot;
  let monthKeys = [];
  try {
    monthKeys = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((name) => /^\d{4}-\d{2}\.db$/.test(name))
      .map((name) => name.replace(/\.db$/i, ""))
      .sort()
      .reverse();
  } catch (_) {
    return null;
  }
  for (const monthKey of monthKeys) {
    const entry = getArchiveEntry(monthKey, false);
    if (!entry) continue;
    const row = entry.selectStopReasonsByAlarmId.get(id);
    if (row) return row;
  }
  return null;
}

async function pruneOldData(options = {}) {
  const opts =
    options && typeof options === "object" ? options : {};
  try {
    const retainDays = Math.max(1, Number(getSetting("retainDays", 90)));
    // v2.11.1 — hard floor bumped 1 → 90 d. The previous max(1,…) replicated
    // the exact unbounded-loss pattern that broke alarms on v2.11.0-beta.9
    // (operator retention=1 → daily DELETE of everything). Even with audit
    // now archived (so the floor is theoretically belt-and-braces), keeping
    // a 90-day hot tier guarantees fast /api/audit responses without a
    // mid-call archive-shard fan-out.
    const auditRetainDays = Math.max(90, Number(getSetting("auditRetainDays", 365)));
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const auditCutoff = Date.now() - auditRetainDays * 24 * 60 * 60 * 1000;
    const mainDbBytesBefore = safeFileSize(DB_PATH);
    const archiveBefore = getArchiveDirStats();
    const archived = await archiveTelemetryBeforeCutoff(cutoff);
    await _yieldEventLoop();
    // v2.11.0-beta.10 — cleared alarms older than `cutoff` are now MIGRATED
    // (not deleted) by archiveTelemetryBeforeCutoff above. The previous
    // unconditional `DELETE FROM alarms ...` here was the source of the
    // 2026-05-22 "can't access past alarms" report: with retainDays=1, the
    // alarm log evaporated daily because there was no archive shard to
    // catch it. Active alarms (cleared_ts IS NULL) still stay hot
    // indefinitely — pruner never touches them.
    await _yieldEventLoop();
    // v2.11.1 — audit_log now MIGRATES to monthly archive shards instead of
    // being permanently DELETE'd. Same data-loss pattern as the v2.11.0-beta.10
    // alarms fix: a low `auditRetainDays` setting used to evaporate the
    // operator's control-action history daily. Archive-aware /api/audit
    // re-merges hot + archive for past-date queries.
    const auditMigrated = await archiveAuditBeforeCutoff(auditCutoff);
    await _yieldEventLoop();
    // v2.9.0 Slice B/D — v2.11.2: counter baselines + clock-sync log now
    // MIGRATE to monthly archive shards instead of permanent DELETE. The
    // baseline rows are the only record of the per-day Etotal/parcE seed
    // used for crash-recovery; losing them after `counterBaselineRetainDays`
    // permanently breaks any post-hoc audit of "what did the hardware say at
    // midnight on YYYY-MM-DD?". Clock-sync log is the operator's only
    // forensic trail for drift incidents — same data-loss class.
    let baselineMigrated = 0;
    let clockSyncMigrated = 0;
    try {
      const baselineRetainDays = Math.max(30, Number(getSetting("counterBaselineRetainDays", 90)));
      const baselineCutoffDate = (() => {
        const d = new Date(Date.now() - baselineRetainDays * 24 * 60 * 60 * 1000);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${day}`;
      })();
      baselineMigrated = await archiveTableBeforeCutoff({
        tableName: "inverter_counter_baseline",
        cutoffColumn: "date_key",
        cutoffValue: baselineCutoffDate,
        monthKeyColumn: "date_key",
        monthKeyKind: "date_string",
      });
      await _yieldEventLoop();
      const clockSyncRetainDays = Math.max(30, Number(getSetting("clockSyncLogRetainDays", 365)));
      const clockSyncCutoff = Date.now() - clockSyncRetainDays * 24 * 60 * 60 * 1000;
      clockSyncMigrated = await archiveTableBeforeCutoff({
        tableName: "inverter_clock_sync_log",
        cutoffColumn: "ts",
        cutoffValue: clockSyncCutoff,
        monthKeyColumn: "ts",
        monthKeyKind: "ms",
      });
    } catch (err) {
      console.warn("[DB] counter/clock-sync archive skipped:", err.message);
    }
    await _yieldEventLoop();
    checkpointArchiveDbs("PASSIVE");
    const checkpointed = checkpointMainDb("PASSIVE");
    const vacuumRequested =
      !!opts.vacuum && (archived.readings > 0 || archived.energy5 > 0 || !!opts.forceVacuum);
    let vacuumed = false;
    if (vacuumRequested) {
      await _yieldEventLoop();
      // Defer VACUUM to background via setImmediate — never block event loop
      setImmediate(() => {
        try {
          vacuumMainDb();
          checkpointMainDb("PASSIVE");
        } catch (e) {
          console.warn("[DB] deferred VACUUM failed:", e.message);
        }
      });
      vacuumed = true; // Mark as requested; actual completion is async
      console.log("[DB] VACUUM deferred — will run in background after prune");
    }
    const mainDbBytesAfter = safeFileSize(DB_PATH);
    const archiveAfter = getArchiveDirStats();
    const result = {
      ok: true,
      retainDays,
      auditRetainDays,
      archived: {
        ...archived,
        audit: auditMigrated,
        counter_baseline: baselineMigrated,
        clock_sync_log: clockSyncMigrated,
      },
      checkpointed,
      vacuumed,
      mainDbBytesBefore,
      mainDbBytesAfter,
      archiveDbFilesBefore: archiveBefore.fileCount,
      archiveDbFilesAfter: archiveAfter.fileCount,
      archiveBytesBefore: archiveBefore.totalBytes,
      archiveBytesAfter: archiveAfter.totalBytes,
    };
    console.log(
      `[DB] Old data pruned. Archived readings=${archived.readings}, energy_5min=${archived.energy5}, alarms=${archived.alarms}, audit=${auditMigrated}, counter_baseline=${baselineMigrated}, clock_sync_log=${clockSyncMigrated}, vacuumed=${vacuumed}.`,
    );
    return result;
  } catch (err) {
    console.error("[DB] pruneOldData failed:", err.message);
    return {
      ok: false,
      error: err.message || "Unknown prune error.",
      archived: { readings: 0, energy5: 0, alarms: 0, audit: 0, counter_baseline: 0, clock_sync_log: 0 },
      checkpointed: false,
      vacuumed: false,
      mainDbBytesBefore: safeFileSize(DB_PATH),
      mainDbBytesAfter: safeFileSize(DB_PATH),
      archiveDbFilesBefore: getArchiveDirStats().fileCount,
      archiveDbFilesAfter: getArchiveDirStats().fileCount,
      archiveBytesBefore: getArchiveDirStats().totalBytes,
      archiveBytesAfter: getArchiveDirStats().totalBytes,
    };
  }
}

function closeArchiveDbs() {
  for (const entry of ARCHIVE_DB_CACHE.values()) {
    try {
      entry.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (_) {
      // Ignore archive checkpoint failures during shutdown.
    }
    try {
      entry.db.close();
    } catch (_) {
      // Ignore archive close failures during shutdown.
    }
  }
  ARCHIVE_DB_CACHE.clear();
}

function closeDb() {
  checkpointMainDb("TRUNCATE");
  closeArchiveDbs();
  try {
    db.close();
  } catch (err) {
    console.error("[DB] close failed:", err.message);
  }
}

// ---------- Scheduled Maintenance CRUD ----------

function getScheduledMaintenance({ inverter, startTs, endTs } = {}) {
  let sql =
    "SELECT * FROM scheduled_maintenance WHERE 1=1";
  const params = [];
  if (inverter !== undefined && inverter !== null) {
    sql += " AND inverter = ?";
    params.push(Number(inverter));
  }
  // Return entries that overlap the requested time window
  if (startTs !== undefined && startTs !== null) {
    sql += " AND end_ts >= ?";
    params.push(Number(startTs));
  }
  if (endTs !== undefined && endTs !== null) {
    sql += " AND start_ts <= ?";
    params.push(Number(endTs));
  }
  sql += " ORDER BY start_ts ASC";
  return db.prepare(sql).all(...params);
}

function insertScheduledMaintenance({ inverter, start_ts, end_ts, reason }) {
  const inv = Number(inverter || 0);
  const s = Number(start_ts);
  const e = Number(end_ts);
  if (!(e > s)) throw new Error("end_ts must be after start_ts");
  const result = db
    .prepare(
      `INSERT INTO scheduled_maintenance (inverter, start_ts, end_ts, reason)
       VALUES (?, ?, ?, ?)`,
    )
    .run(inv, s, e, String(reason || "").trim());
  return result.lastInsertRowid;
}

function deleteScheduledMaintenance(id) {
  const result = db
    .prepare("DELETE FROM scheduled_maintenance WHERE id = ?")
    .run(Number(id));
  return result.changes;
}

// ── v2.11.0 Active Power Control helpers ─────────────────────────────────────

function upsertCurtailmentState(inverterIp, slave, activePct, opcode, jobId, source) {
  db.prepare(
    `INSERT INTO inverter_curtailment_state
       (inverter_ip, slave, active_pct, opcode, applied_ts, job_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(inverter_ip, slave) DO UPDATE SET
       active_pct = excluded.active_pct,
       opcode     = excluded.opcode,
       applied_ts = excluded.applied_ts,
       job_id     = excluded.job_id,
       source     = excluded.source`,
  ).run(
    String(inverterIp),
    Number(slave),
    Number(activePct),
    Number(opcode),
    Date.now(),
    jobId ? String(jobId) : null,
    source ? String(source) : "operator",
  );
}

function insertRampLog({ job_id, ts, inverter_ip, slave, sub_step, batch_idx, setpoint_pct, result, error }) {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO inverter_curtailment_ramp_log
         (job_id, ts, inverter_ip, slave, sub_step, batch_idx, setpoint_pct, result, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      String(job_id),
      Number(ts) || Date.now(),
      inverter_ip ? String(inverter_ip) : null,
      slave != null ? Number(slave) : null,
      sub_step != null ? Number(sub_step) : null,
      batch_idx != null ? Number(batch_idx) : null,
      setpoint_pct != null ? Number(setpoint_pct) : null,
      result ? String(result) : null,
      error ? String(error) : null,
    );
  } catch (err) {
    console.warn("[ramp_log] insert failed:", err && err.message);
  }
}

function getApcState() {
  return db.prepare("SELECT * FROM inverter_curtailment_state ORDER BY inverter_ip, slave").all();
}

function markStaleRampsAborted() {
  // On dashboard start, any log rows without a terminal result are from a mid-ramp restart.
  const rows = db.prepare(
    "SELECT DISTINCT job_id FROM inverter_curtailment_ramp_log WHERE result IS NULL",
  ).all();
  if (!rows.length) return 0;
  const stmt = db.prepare(
    "UPDATE inverter_curtailment_ramp_log SET result = 'aborted', error = 'dashboard_restart' WHERE job_id = ? AND result IS NULL",
  );
  const tx = db.transaction(() => {
    for (const r of rows) stmt.run(r.job_id);
  });
  tx();
  return rows.length;
}

async function pruneRampLog(retainDays = 90) {
  // v2.11.2 — was DELETE-only (and orphaned, never called); now migrates
  // ramp-log rows to the monthly archive shard. The ramp log is the per-
  // write detail trail for every curtailment job — same compliance class
  // as apc_verify_log, must survive operator retention tightening.
  const cutoff = Date.now() - Math.max(7, Number(retainDays) || 90) * 86400000;
  return archiveTableBeforeCutoff({
    tableName: "inverter_curtailment_ramp_log",
    cutoffColumn: "ts",
    cutoffValue: cutoff,
    monthKeyColumn: "ts",
    monthKeyKind: "ms",
  });
}

/* ── IGBT Health Phase 2.1 — thermal baseline helpers ────────────────────── */

const stmtUpsertThermalBaseline = db.prepare(`
  INSERT INTO igbt_thermal_baseline
    (inverter_ip, slave, date_local, sample_count, mean_temp_c, reason, computed_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(inverter_ip, slave, date_local) DO UPDATE SET
    sample_count   = excluded.sample_count,
    mean_temp_c    = excluded.mean_temp_c,
    reason         = excluded.reason,
    computed_at_ms = excluded.computed_at_ms
`);

function upsertIgbtThermalBaseline({ inverter_ip, slave, date_local, sample_count, mean_temp_c, reason, computed_at_ms }) {
  return stmtUpsertThermalBaseline.run(
    String(inverter_ip || ""),
    Number(slave),
    String(date_local || ""),
    Number(sample_count) || 0,
    mean_temp_c == null ? null : Number(mean_temp_c),
    String(reason || "no_data"),
    Number(computed_at_ms) || Date.now(),
  );
}

const stmtGetThermalBaselineRange = db.prepare(`
  SELECT date_local, sample_count, mean_temp_c, reason
    FROM igbt_thermal_baseline
   WHERE inverter_ip = ? AND slave = ?
     AND date_local BETWEEN ? AND ?
   ORDER BY date_local ASC
`);

function getIgbtThermalBaselineRange(inverter_ip, slave, fromDateInclusive, toDateInclusive) {
  return stmtGetThermalBaselineRange.all(
    String(inverter_ip || ""),
    Number(slave),
    String(fromDateInclusive || ""),
    String(toDateInclusive || ""),
  );
}

const stmtGetThermalBaselineDates = db.prepare(`
  SELECT DISTINCT date_local FROM igbt_thermal_baseline
   WHERE inverter_ip = ? AND slave = ?
     AND date_local BETWEEN ? AND ?
`);

function getIgbtThermalBaselineDateSet(inverter_ip, slave, fromDateInclusive, toDateInclusive) {
  const rows = stmtGetThermalBaselineDates.all(
    String(inverter_ip || ""),
    Number(slave),
    String(fromDateInclusive || ""),
    String(toDateInclusive || ""),
  );
  const set = new Set();
  for (const r of rows) set.add(String(r?.date_local || ""));
  return set;
}

const stmt5minParamForDay = db.prepare(`
  SELECT slot_index, pac_w, temp_c
    FROM inverter_5min_param
   WHERE inverter_ip = ? AND slave = ? AND date_local = ?
`);

function get5minParamRowsForDay(inverter_ip, slave, date_local) {
  return stmt5minParamForDay.all(
    String(inverter_ip || ""),
    Number(slave),
    String(date_local || ""),
  );
}

// Slice κ.8 (2026-05-12) — phase-unbalance gate query. Used by the
// critical-pattern enforcer to confirm a measurement-side signal before
// auto-blocking. Returns up to `limit` most-recent rows (DESC by updated_ts)
// for the given inverter_ip/slave, restricted to rows newer than `cutoffMs`.
// Only the fields needed by phaseUnbalance.computeUnbalanceFromRow.
const stmtRecent5MinParamForUnbalance = db.prepare(`
  SELECT iac1_a, iac2_a, iac3_a, pac_w, in_solar_window,
         date_local, slot_index, updated_ts
    FROM inverter_5min_param
   WHERE inverter_ip = ? AND slave = ? AND updated_ts >= ?
   ORDER BY updated_ts DESC
   LIMIT ?
`);

function getRecent5MinParamForUnbalance(inverter_ip, slave, cutoffMs, limit = 6) {
  return stmtRecent5MinParamForUnbalance.all(
    String(inverter_ip || ""),
    Number(slave),
    Math.max(0, Number(cutoffMs) || 0),
    Math.max(1, Math.min(64, Number(limit) || 6)),
  );
}

// Aging-relevant motive codes (kept here so the capture job can stay generic).
// Source: server/motiveLabelsStd.js + plans/igbt-health-phase1.md §5.
const IGBT_AGING_MOTIVE_CODES = [7, 13, 21, 26, 29, 30];

const stmtAgingStopForDay = db.prepare(`
  SELECT 1 FROM inverter_stop_reasons_std
   WHERE inverter_ip = ? AND slave = ?
     AND read_at_ms BETWEEN ? AND ?
     AND motive_code IN (${IGBT_AGING_MOTIVE_CODES.join(",")})
   LIMIT 1
`);

function dayHadAgingStopEvent(inverter_ip, slave, date_local) {
  // Local-day window expressed in ms via UTC midnight. The 5-min table stores
  // date_local as YYYY-MM-DD; the stop_reasons table only has read_at_ms.
  // We bound by [day 00:00, day+1 00:00) in local time.
  const ts = Date.parse(String(date_local) + "T00:00:00");
  if (!Number.isFinite(ts)) return false;
  const start = ts;
  const end = ts + 86400_000 - 1;
  const row = stmtAgingStopForDay.get(
    String(inverter_ip || ""),
    Number(slave),
    start,
    end,
  );
  return !!row;
}

/* ── Plant Controller — NGCP compliance run helpers (v2.11.0) ───────────── */

const stmtInsertComplianceRun = db.prepare(`
  INSERT INTO compliance_run
    (run_id, test_kind, started_at_ms, status, operator_actor, target_inverters, params_json)
  VALUES (?, ?, ?, 'running', ?, ?, ?)
`);
const stmtUpdateComplianceRunFinal = db.prepare(`
  UPDATE compliance_run
     SET ended_at_ms = ?, status = ?, summary_json = ?, error_message = ?
   WHERE run_id = ?
`);
const stmtListComplianceRuns = db.prepare(`
  SELECT * FROM compliance_run ORDER BY started_at_ms DESC LIMIT ?
`);
const stmtGetComplianceRun = db.prepare(`SELECT * FROM compliance_run WHERE run_id = ?`);
const stmtListComplianceRunsByKind = db.prepare(`
  SELECT * FROM compliance_run WHERE test_kind = ? ORDER BY started_at_ms DESC LIMIT ?
`);

const stmtInsertComplianceStep = db.prepare(`
  INSERT INTO compliance_run_step
    (run_id, step_idx, step_name, started_at_ms, ended_at_ms, target_value, achieved_value, deviation_pct, pass, notes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, step_idx) DO UPDATE SET
    step_name=excluded.step_name, started_at_ms=excluded.started_at_ms,
    ended_at_ms=excluded.ended_at_ms, target_value=excluded.target_value,
    achieved_value=excluded.achieved_value, deviation_pct=excluded.deviation_pct,
    pass=excluded.pass, notes=excluded.notes
`);
const stmtListComplianceSteps = db.prepare(`
  SELECT * FROM compliance_run_step WHERE run_id = ? ORDER BY step_idx ASC
`);

const stmtInsertComplianceSample = db.prepare(`
  INSERT INTO compliance_run_sample
    (run_id, ts_ms, inverter_ip, slave, pac_w, qac_var, vac_avg_v, iac_avg_a, freq_hz, cosphi, temp_c, state_raw, alarm_32, pwr_red_bits)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, ts_ms, inverter_ip, slave) DO UPDATE SET
    pac_w=excluded.pac_w, qac_var=excluded.qac_var,
    vac_avg_v=excluded.vac_avg_v, iac_avg_a=excluded.iac_avg_a,
    freq_hz=excluded.freq_hz, cosphi=excluded.cosphi, temp_c=excluded.temp_c,
    state_raw=excluded.state_raw, alarm_32=excluded.alarm_32, pwr_red_bits=excluded.pwr_red_bits
`);
const stmtListComplianceSamples = db.prepare(`
  SELECT * FROM compliance_run_sample WHERE run_id = ? ORDER BY ts_ms ASC, inverter_ip ASC, slave ASC
`);

const stmtInsertComplianceArtifact = db.prepare(`
  INSERT INTO compliance_run_artifact
    (run_id, artifact_kind, file_path, sha256, bytes, created_at_ms)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, artifact_kind, file_path) DO UPDATE SET
    sha256=excluded.sha256, bytes=excluded.bytes, created_at_ms=excluded.created_at_ms
`);
const stmtListComplianceArtifacts = db.prepare(`
  SELECT * FROM compliance_run_artifact WHERE run_id = ? ORDER BY created_at_ms ASC
`);

function insertComplianceRun({ run_id, test_kind, started_at_ms, operator_actor, target_inverters, params_json }) {
  return stmtInsertComplianceRun.run(
    String(run_id), String(test_kind), Number(started_at_ms),
    operator_actor == null ? "system" : String(operator_actor),
    target_inverters == null ? "[]" : JSON.stringify(target_inverters),
    params_json == null ? "{}" : (typeof params_json === "string" ? params_json : JSON.stringify(params_json)),
  );
}

function finalizeComplianceRun({ run_id, ended_at_ms, status, summary_json, error_message }) {
  return stmtUpdateComplianceRunFinal.run(
    Number(ended_at_ms) || Date.now(),
    String(status || "completed"),
    summary_json == null ? null : (typeof summary_json === "string" ? summary_json : JSON.stringify(summary_json)),
    error_message ? String(error_message) : null,
    String(run_id),
  );
}

function listComplianceRuns(limit = 50, kind) {
  if (kind) return stmtListComplianceRunsByKind.all(String(kind), Math.max(1, Math.min(500, Number(limit) || 50)));
  return stmtListComplianceRuns.all(Math.max(1, Math.min(500, Number(limit) || 50)));
}

function getComplianceRun(run_id) {
  return stmtGetComplianceRun.get(String(run_id));
}

function appendComplianceStep(step) {
  return stmtInsertComplianceStep.run(
    String(step.run_id), Number(step.step_idx), String(step.step_name || ""),
    Number(step.started_at_ms) || Date.now(),
    step.ended_at_ms == null ? null : Number(step.ended_at_ms),
    step.target_value == null ? null : Number(step.target_value),
    step.achieved_value == null ? null : Number(step.achieved_value),
    step.deviation_pct == null ? null : Number(step.deviation_pct),
    step.pass == null ? null : (step.pass ? 1 : 0),
    step.notes ? String(step.notes) : null,
  );
}

function listComplianceSteps(run_id) {
  return stmtListComplianceSteps.all(String(run_id));
}

function appendComplianceSample(s) {
  return stmtInsertComplianceSample.run(
    String(s.run_id), Number(s.ts_ms), String(s.inverter_ip), Number(s.slave),
    s.pac_w == null ? null : Number(s.pac_w),
    s.qac_var == null ? null : Number(s.qac_var),
    s.vac_avg_v == null ? null : Number(s.vac_avg_v),
    s.iac_avg_a == null ? null : Number(s.iac_avg_a),
    s.freq_hz == null ? null : Number(s.freq_hz),
    s.cosphi == null ? null : Number(s.cosphi),
    s.temp_c == null ? null : Number(s.temp_c),
    s.state_raw == null ? null : Number(s.state_raw),
    s.alarm_32 == null ? null : Number(s.alarm_32),
    s.pwr_red_bits == null ? null : Number(s.pwr_red_bits),
  );
}

function listComplianceSamples(run_id) {
  return stmtListComplianceSamples.all(String(run_id));
}

// v2.11.x — cheap COUNT(*) for the /status endpoint so the operator UI can
// show running "samples persisted" while the test is in flight without
// shipping the whole sample list every 3 s.
const stmtCountComplianceSamples = db.prepare(
  `SELECT COUNT(*) AS n FROM compliance_run_sample WHERE run_id = ?`,
);
function countComplianceSamples(run_id) {
  const r = stmtCountComplianceSamples.get(String(run_id));
  return Number(r?.n || 0);
}

function appendComplianceArtifact({ run_id, artifact_kind, file_path, sha256, bytes }) {
  return stmtInsertComplianceArtifact.run(
    String(run_id), String(artifact_kind), String(file_path),
    sha256 == null ? null : String(sha256),
    bytes == null ? null : Number(bytes),
    Date.now(),
  );
}

function listComplianceArtifacts(run_id) {
  return stmtListComplianceArtifacts.all(String(run_id));
}

/* ── Plant Controller — APC verification log helpers (Slice δ) ───────────── */

const stmtInsertApcVerify = db.prepare(`
  INSERT INTO apc_verify_log
    (write_ts_ms, verify_ts_ms, inverter_ip, slave, requested_pct, observed_q15, observed_pct, bit1_active, result, job_id, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtLatestApcVerifyByNode = db.prepare(`
  SELECT * FROM apc_verify_log
   WHERE inverter_ip = ? AND slave = ?
   ORDER BY write_ts_ms DESC LIMIT 1
`);
const stmtLatestApcVerifyAll = db.prepare(`
  SELECT v.* FROM apc_verify_log v
   INNER JOIN (
     SELECT inverter_ip, slave, MAX(write_ts_ms) AS mx
       FROM apc_verify_log GROUP BY inverter_ip, slave
   ) m ON m.inverter_ip = v.inverter_ip AND m.slave = v.slave AND m.mx = v.write_ts_ms
   ORDER BY v.write_ts_ms DESC
`);
const stmtPruneApcVerify = db.prepare(`
  DELETE FROM apc_verify_log WHERE write_ts_ms < ?
`);

function insertApcVerifyLog(row) {
  return stmtInsertApcVerify.run(
    Number(row.write_ts_ms) || Date.now(),
    row.verify_ts_ms == null ? null : Number(row.verify_ts_ms),
    String(row.inverter_ip || ""), Number(row.slave),
    Number(row.requested_pct),
    row.observed_q15 == null ? null : Number(row.observed_q15),
    row.observed_pct == null ? null : Number(row.observed_pct),
    row.bit1_active == null ? null : (row.bit1_active ? 1 : 0),
    String(row.result || "pending"),
    row.job_id ? String(row.job_id) : null,
    row.error_message ? String(row.error_message) : null,
  );
}

function getLatestApcVerify(inverter_ip, slave) {
  return stmtLatestApcVerifyByNode.get(String(inverter_ip || ""), Number(slave));
}

function getLatestApcVerifyAll() {
  return stmtLatestApcVerifyAll.all();
}

async function pruneApcVerifyLog(retainDays = 90) {
  // v2.11.2 — was DELETE-only; the APC verify trail is the compliance
  // record proving each %P setpoint write was acknowledged by the
  // inverter, so retention now MIGRATES the rows to the monthly archive
  // shard instead of dropping them.
  const cutoff = Date.now() - Math.max(7, Number(retainDays) || 90) * 86400_000;
  return archiveTableBeforeCutoff({
    tableName: "apc_verify_log",
    cutoffColumn: "write_ts_ms",
    cutoffValue: cutoff,
    monthKeyColumn: "write_ts_ms",
    monthKeyKind: "ms",
  });
}

/* ── v2.11.x Phase 3 — grid_control_verify_log helpers (Slice ζ verify) ── */

const stmtInsertGcVerify = db.prepare(`
  INSERT INTO grid_control_verify_log
    (write_ts_ms, verify_ts_ms, inverter_ip, slave, kind, requested_raw, observed_raw, result, operator, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtLatestGcVerifyByNode = db.prepare(`
  SELECT * FROM grid_control_verify_log
   WHERE inverter_ip = ? AND slave = ?
   ORDER BY write_ts_ms DESC LIMIT 1
`);
const stmtLatestGcVerifyAll = db.prepare(`
  SELECT v.* FROM grid_control_verify_log v
   INNER JOIN (
     SELECT inverter_ip, slave, MAX(write_ts_ms) AS mx
       FROM grid_control_verify_log GROUP BY inverter_ip, slave
   ) m ON m.inverter_ip = v.inverter_ip AND m.slave = v.slave AND m.mx = v.write_ts_ms
   ORDER BY v.write_ts_ms DESC
`);
const stmtPruneGcVerify = db.prepare(`
  DELETE FROM grid_control_verify_log WHERE write_ts_ms < ?
`);

function insertGridControlVerifyLog(row) {
  return stmtInsertGcVerify.run(
    Number(row.write_ts_ms) || Date.now(),
    row.verify_ts_ms == null ? null : Number(row.verify_ts_ms),
    String(row.inverter_ip || ""), Number(row.slave),
    String(row.kind || ""),
    row.requested_raw == null ? null : Number(row.requested_raw),
    row.observed_raw == null ? null : Number(row.observed_raw),
    String(row.result || "pending"),
    row.operator ? String(row.operator).slice(0, 64) : null,
    row.error_message ? String(row.error_message) : null,
  );
}

function getLatestGridControlVerify(inverter_ip, slave) {
  return stmtLatestGcVerifyByNode.get(String(inverter_ip || ""), Number(slave));
}

function getLatestGridControlVerifyAll() {
  return stmtLatestGcVerifyAll.all();
}

async function pruneGridControlVerifyLog(retainDays = 90) {
  // v2.11.2 — was DELETE-only (and orphaned, never called); now migrates
  // grid-control verify rows to the monthly archive shard. The cron in
  // server/index.js now wires this on the same Sunday-04:30 cadence as
  // the APC verify log so both Plant-Controller audit trails decay
  // together.
  const cutoff = Date.now() - Math.max(7, Number(retainDays) || 90) * 86400_000;
  return archiveTableBeforeCutoff({
    tableName: "grid_control_verify_log",
    cutoffColumn: "write_ts_ms",
    cutoffValue: cutoff,
    monthKeyColumn: "write_ts_ms",
    monthKeyKind: "ms",
  });
}

async function pruneIgbtThermalBaseline(retainDays = 800) {
  // Keep ≥ 2 years so YoY comparisons still work after a long uptime.
  // v2.11.2 — rows now MIGRATE to monthly archive shards (was DELETE-only).
  // Thermal baselines are the only IGBT-aging audit trail; once they age
  // out of the hot table they're irreplaceable (the 5-min source rows that
  // computed them have already moved to readings archives). The universal
  // archive helper supports WITHOUT ROWID + composite-PK tables.
  const cutoffDays = Math.max(400, Math.floor(Number(retainDays) || 800));
  const cutoffDate = new Date(Date.now() - cutoffDays * 86400_000)
    .toISOString().slice(0, 10);
  return archiveTableBeforeCutoff({
    tableName: "igbt_thermal_baseline",
    cutoffColumn: "date_local",
    cutoffValue: cutoffDate,
    monthKeyColumn: "date_local",
    monthKeyKind: "date_string",
  });
}

// ── v2.11.x Slice κ.3 — inverter_critical_blocks DAO ────────────────────────
// One active row per inverter at a time. "Active" = acked_at_ms IS NULL.
// History rows (acked) are kept indefinitely for forensic review.

// "Active" = STOP-issued + manual-write-locked. Slice κ.9: a 'pending' row is
// armed during the solar window but has NOT issued STOP and must NOT lock
// manual writes or consume the fleet cap — so every active-block query filters
// state='active' explicitly. Legacy rows are 'active' via the column default.
function getActiveCriticalBlock(inverter) {
  return db.prepare(`
    SELECT * FROM inverter_critical_blocks
      WHERE inverter = ? AND acked_at_ms IS NULL AND state = 'active'
      ORDER BY id DESC LIMIT 1
  `).get(Number(inverter));
}

function getAllActiveCriticalBlocks() {
  return db.prepare(`
    SELECT * FROM inverter_critical_blocks
      WHERE acked_at_ms IS NULL AND state = 'active'
      ORDER BY inverter ASC
  `).all();
}

function getAllPendingCriticalBlocks() {
  return db.prepare(`
    SELECT * FROM inverter_critical_blocks
      WHERE acked_at_ms IS NULL AND state = 'pending'
      ORDER BY inverter ASC
  `).all();
}

// Slice κ.9 — the armed-but-deferred row for an inverter (one at a time).
function getPendingCriticalBlock(inverter) {
  return db.prepare(`
    SELECT * FROM inverter_critical_blocks
      WHERE inverter = ? AND acked_at_ms IS NULL AND state = 'pending'
      ORDER BY id DESC LIMIT 1
  `).get(Number(inverter));
}

// Arm (or refresh) a pending block: pattern+imbalance confirmed DURING the
// solar window, STOP deferred until the window closes. No STOP, no write-lock.
// Refresh-in-place keeps the operator-visible "armed" row id stable.
function armOrRefreshPendingCriticalBlock(row) {
  const r = row || {};
  const now = Number(r.armed_at_ms) || Date.now();
  const latched = r.unbalance_latched == null
    ? null
    : (typeof r.unbalance_latched === "string"
        ? r.unbalance_latched
        : JSON.stringify(r.unbalance_latched));
  const existing = getPendingCriticalBlock(r.inverter);
  if (existing) {
    db.prepare(`
      UPDATE inverter_critical_blocks
         SET pattern_key       = ?,
             pattern_hex       = ?,
             pattern_label     = ?,
             triggering_slave  = ?,
             count_in_window   = ?,
             latest_episode_ts = ?,
             armed_at_ms       = ?,
             unbalance_latched = COALESCE(?, unbalance_latched),
             updated_ts        = ?
       WHERE id = ?
    `).run(
      String(r.pattern_key || ""),
      String(r.pattern_hex || ""),
      r.pattern_label == null ? null : String(r.pattern_label),
      r.triggering_slave == null ? null : Number(r.triggering_slave),
      r.count_in_window == null ? null : Number(r.count_in_window),
      r.latest_episode_ts == null ? null : Number(r.latest_episode_ts),
      now,
      latched,
      Date.now(),
      existing.id,
    );
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO inverter_critical_blocks
      (inverter, created_at_ms, pattern_key, pattern_hex, pattern_label,
       triggering_slave, count_in_window, latest_episode_ts,
       stop_issued_at_ms, stop_result, last_reenforced_ms, reenforce_count,
       state, armed_at_ms, unbalance_latched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 'pending', ?, ?)
  `).run(
    Number(r.inverter),
    now,
    String(r.pattern_key || ""),
    String(r.pattern_hex || ""),
    r.pattern_label == null ? null : String(r.pattern_label),
    r.triggering_slave == null ? null : Number(r.triggering_slave),
    r.count_in_window == null ? null : Number(r.count_in_window),
    r.latest_episode_ts == null ? null : Number(r.latest_episode_ts),
    now,
    latched,
  ).lastInsertRowid;
}

// Convert a pending row to active when the solar window has closed and the
// pattern is still critical. Preserves the row id (UI continuity) and stamps
// the real block-open + STOP time.
function activatePendingCriticalBlock(id, nowMs, stopResult) {
  const now = Number(nowMs) || Date.now();
  return db.prepare(`
    UPDATE inverter_critical_blocks
       SET state              = 'active',
           created_at_ms      = ?,
           stop_issued_at_ms  = ?,
           stop_result        = ?,
           last_reenforced_ms = ?,
           updated_ts         = ?
     WHERE id = ? AND acked_at_ms IS NULL AND state = 'pending'
  `).run(now, now, stopResult || null, now, now, Number(id)).changes;
}

// Disarm a pending row that never executed (pattern resolved before the solar
// window closed). Marked acked by SYSTEM so it drops out of pending/active
// queries but is retained for forensic review (append-only history style).
function disarmPendingCriticalBlock(inverter, reason) {
  const pend = getPendingCriticalBlock(inverter);
  if (!pend) return 0;
  const now = Date.now();
  return db.prepare(`
    UPDATE inverter_critical_blocks
       SET acked_at_ms = ?, acked_by = 'SYSTEM:DISARM_PRESOLAR',
           ack_note = ?, updated_ts = ?
     WHERE id = ?
  `).run(now, reason ? String(reason).slice(0, 200) : "pattern_resolved", now, pend.id).changes;
}

function getCriticalBlockHistory(inverter, limit = 50) {
  return db.prepare(`
    SELECT * FROM inverter_critical_blocks
      WHERE inverter = ?
      ORDER BY id DESC LIMIT ?
  `).all(Number(inverter), Math.min(500, Math.max(1, Number(limit) || 50)));
}

// v2.11.x Slice κ.5 — latest acked block for an inverter. Drives the
// "reset counter after Confirm" semantics: alarm-pattern episode counting
// and EOL health signaling both ignore evidence older than the acked_at_ms
// timestamp returned here, so a fresh fault must occur *after* the
// operator confirms the fix before the inverter is re-blocked.
function getLatestAckedCriticalBlock(inverter) {
  return db.prepare(`
    SELECT * FROM inverter_critical_blocks
      WHERE inverter = ? AND acked_at_ms IS NOT NULL
      ORDER BY acked_at_ms DESC LIMIT 1
  `).get(Number(inverter));
}

function insertCriticalBlock(row) {
  const r = row || {};
  return db.prepare(`
    INSERT INTO inverter_critical_blocks
      (inverter, created_at_ms, pattern_key, pattern_hex, pattern_label,
       triggering_slave, count_in_window, latest_episode_ts,
       stop_issued_at_ms, stop_result, last_reenforced_ms, reenforce_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    Number(r.inverter),
    Number(r.created_at_ms) || Date.now(),
    String(r.pattern_key || ""),
    String(r.pattern_hex || ""),
    r.pattern_label == null ? null : String(r.pattern_label),
    r.triggering_slave == null ? null : Number(r.triggering_slave),
    r.count_in_window == null ? null : Number(r.count_in_window),
    r.latest_episode_ts == null ? null : Number(r.latest_episode_ts),
    r.stop_issued_at_ms == null ? null : Number(r.stop_issued_at_ms),
    r.stop_result == null ? null : String(r.stop_result),
    r.last_reenforced_ms == null ? null : Number(r.last_reenforced_ms),
  ).lastInsertRowid;
}

function updateCriticalBlockReenforcement(id, nowMs, stopResult) {
  return db.prepare(`
    UPDATE inverter_critical_blocks
       SET last_reenforced_ms = ?,
           reenforce_count    = reenforce_count + 1,
           stop_result        = COALESCE(?, stop_result),
           updated_ts         = ?
     WHERE id = ?
  `).run(Number(nowMs) || Date.now(), stopResult || null, Date.now(), Number(id)).changes;
}

// v2.11.x Slice κ.3 — in-place promotion of the active block when a more
// severe pattern (per CRITICAL_PATTERNS.severity_rank) becomes critical
// while the lesser pattern's block is still open. Updates pattern_key /
// pattern_hex / pattern_label / triggering_slave / count_in_window /
// latest_episode_ts ONLY — preserves audit fields (created_at_ms, stop_*,
// reenforce_count). Operator's ack still references the block by id.
function updateCriticalBlockPattern(id, fields, nowMs) {
  const f = fields || {};
  return db.prepare(`
    UPDATE inverter_critical_blocks
       SET pattern_key      = COALESCE(?, pattern_key),
           pattern_hex      = COALESCE(?, pattern_hex),
           pattern_label    = COALESCE(?, pattern_label),
           triggering_slave = COALESCE(?, triggering_slave),
           count_in_window  = COALESCE(?, count_in_window),
           latest_episode_ts = COALESCE(?, latest_episode_ts),
           updated_ts       = ?
     WHERE id = ? AND acked_at_ms IS NULL
  `).run(
    f.pattern_key   == null ? null : String(f.pattern_key),
    f.pattern_hex   == null ? null : String(f.pattern_hex),
    f.pattern_label == null ? null : String(f.pattern_label),
    f.triggering_slave == null ? null : Number(f.triggering_slave),
    f.count_in_window  == null ? null : Number(f.count_in_window),
    f.latest_episode_ts == null ? null : Number(f.latest_episode_ts),
    Number(nowMs) || Date.now(),
    Number(id),
  ).changes;
}

function ackCriticalBlock(inverter, ackedBy, note) {
  // Closes the active block for this inverter, or — Slice κ.9 — an armed
  // (pending) block if no active one exists. The operator must be able to
  // dismiss an armed-but-not-yet-executed deferral (e.g. a known-good
  // precursor) BEFORE it converts at solar-window close; otherwise the
  // pending row is invisible to the ack path and would still STOP later.
  const target = getActiveCriticalBlock(inverter) || getPendingCriticalBlock(inverter);
  if (!target) return { ok: false, error: "no_active_block" };
  const wasPending = target.state === "pending";
  const now = Date.now();
  const changes = db.prepare(`
    UPDATE inverter_critical_blocks
       SET acked_at_ms = ?, acked_by = ?, ack_note = ?, updated_ts = ?
     WHERE id = ?
  `).run(now, String(ackedBy || "OPERATOR"), note ? String(note) : null, now, target.id).changes;
  return { ok: changes > 0, id: target.id, acked_at_ms: now, was_pending: wasPending };
}

// ─── v2.11.x Field Calibration (Phases 2-4) — DB helpers ─────────────────
// Plan: plans/2026-05-12-inverter-calibration-tool.md
// All inserts here are append-only for forensic durability.

function insertCalibrationSnapshot(row) {
  const r = row || {};
  return db.prepare(`
    INSERT INTO calibration_snapshot
      (ts_utc, inverter_id, inverter_ip, slave, source, session_id,
       reg_block_hex, valid_cfg_code, model_code, firmware_main, serial, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(r.ts_utc) || Date.now(),
    Number(r.inverter_id),
    String(r.inverter_ip || ""),
    Number(r.slave),
    String(r.source || "baseline"),
    r.session_id == null ? null : String(r.session_id),
    String(r.reg_block_hex || ""),
    r.valid_cfg_code == null ? null : Number(r.valid_cfg_code),
    r.model_code == null ? null : String(r.model_code),
    r.firmware_main == null ? null : String(r.firmware_main),
    r.serial == null ? null : String(r.serial),
    r.notes == null ? null : String(r.notes),
  ).lastInsertRowid;
}

function getLatestCalibrationSnapshot(inverter_id, slave) {
  return db.prepare(`
    SELECT * FROM calibration_snapshot
     WHERE inverter_id = ? AND slave = ?
     ORDER BY ts_utc DESC LIMIT 1
  `).get(Number(inverter_id), Number(slave)) || null;
}

function listCalibrationSnapshots(inverter_id, slave, limit) {
  return db.prepare(`
    SELECT * FROM calibration_snapshot
     WHERE inverter_id = ? AND slave = ?
     ORDER BY ts_utc DESC LIMIT ?
  `).all(Number(inverter_id), Number(slave),
        Math.min(100, Math.max(1, Number(limit) || 20)));
}

function getCalibrationSnapshotById(id) {
  return db.prepare(`
    SELECT * FROM calibration_snapshot WHERE id = ?
  `).get(Number(id)) || null;
}

function deleteCalibrationSnapshotById(id) {
  return db.prepare(`
    DELETE FROM calibration_snapshot WHERE id = ?
  `).run(Number(id)).changes;
}

function insertCalibrationWriteLog(row) {
  const r = row || {};
  return db.prepare(`
    INSERT INTO calibration_write_log
      (ts_utc, session_id, inverter_id, inverter_ip, slave, reg_offset,
       param_name, value_before, value_requested, value_after,
       verify_ok, operator, auth_method, error_detail, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Number(r.ts_utc) || Date.now(),
    String(r.session_id || ""),
    Number(r.inverter_id),
    String(r.inverter_ip || ""),
    Number(r.slave),
    Number(r.reg_offset),
    String(r.param_name || ""),
    r.value_before == null ? null : Number(r.value_before),
    Number(r.value_requested),
    r.value_after == null ? null : Number(r.value_after),
    r.verify_ok ? 1 : 0,
    r.operator == null ? null : String(r.operator),
    r.auth_method == null ? null : String(r.auth_method),
    r.error_detail == null ? null : String(r.error_detail),
    r.notes == null ? null : String(r.notes),
  ).lastInsertRowid;
}

function listCalibrationWriteLog(filters) {
  const f = filters || {};
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 100));
  if (f.session_id) {
    return db.prepare(`
      SELECT * FROM calibration_write_log
       WHERE session_id = ? ORDER BY ts_utc DESC LIMIT ?
    `).all(String(f.session_id), limit);
  }
  if (Number.isInteger(Number(f.inverter_id))) {
    return db.prepare(`
      SELECT * FROM calibration_write_log
       WHERE inverter_id = ? ${f.slave ? "AND slave = ?" : ""}
       ORDER BY ts_utc DESC LIMIT ?
    `).all(...(f.slave
      ? [Number(f.inverter_id), Number(f.slave), limit]
      : [Number(f.inverter_id), limit]));
  }
  return db.prepare(`
    SELECT * FROM calibration_write_log
     ORDER BY ts_utc DESC LIMIT ?
  `).all(limit);
}

function insertCalibrationSession(row) {
  const r = row || {};
  return db.prepare(`
    INSERT OR REPLACE INTO calibration_session_log
      (session_id, inverter_id, slave, operator, started_at_ms,
       ended_at_ms, end_reason, write_count, consign_writes, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(r.session_id),
    Number(r.inverter_id),
    Number(r.slave),
    r.operator == null ? null : String(r.operator),
    Number(r.started_at_ms) || Date.now(),
    r.ended_at_ms == null ? null : Number(r.ended_at_ms),
    r.end_reason == null ? null : String(r.end_reason),
    Number(r.write_count) || 0,
    Number(r.consign_writes) || 0,
    r.notes == null ? null : String(r.notes),
  );
}

function updateCalibrationSessionEnd(session_id, end_reason, counts) {
  const c = counts || {};
  return db.prepare(`
    UPDATE calibration_session_log
       SET ended_at_ms    = ?,
           end_reason     = ?,
           write_count    = COALESCE(?, write_count),
           consign_writes = COALESCE(?, consign_writes),
           notes          = COALESCE(?, notes)
     WHERE session_id = ?
  `).run(
    Date.now(),
    String(end_reason || "operator"),
    c.write_count == null ? null : Number(c.write_count),
    c.consign_writes == null ? null : Number(c.consign_writes),
    c.notes == null ? null : String(c.notes),
    String(session_id),
  ).changes;
}

function getCalibrationSession(session_id) {
  return db.prepare(
    `SELECT * FROM calibration_session_log WHERE session_id = ?`,
  ).get(String(session_id)) || null;
}

function listRecentCalibrationSessions(limit) {
  return db.prepare(`
    SELECT * FROM calibration_session_log
     ORDER BY started_at_ms DESC LIMIT ?
  `).all(Math.min(100, Math.max(1, Number(limit) || 20)));
}

module.exports = {
  db,
  stmts,
  bulkInsert,
  bulkInsertWithSummary,
  bulkInsertPollerBatch,
  bulkUpsertForecastDayAhead,
  bulkUpsertForecastIntradayAdjusted,
  bulkUpsertSolcastSnapshot,
  bulkBackfillSolcastEstActual,
  getSolcastSnapshotForDay,
  // Day-ahead locked snapshot (v2.8+)
  bulkInsertDayAheadLocked,
  countDayAheadLockedForDay,
  getDayAheadLockedForDay,
  getDayAheadLockedMetaForDay,
  // Solcast snapshot history (v2.8+)
  bulkInsertSnapshotHistory,
  pruneSnapshotHistory,
  getSnapshotHistoryDayTrajectory,
  getSetting,
  setSetting,
  pruneOldData,
  closeDb,
  // v2.8.10 Phase C: startup integrity snapshot + auto-restore result.
  // Consumed by server/index.js GET /api/health/db-integrity.
  startupIntegrityResult,
  DATA_DIR,
  ARCHIVE_DIR,
  SUMMARY_SOLAR_START_H,
  SUMMARY_SOLAR_END_H,
  SUMMARY_MAX_GAP_S,
  localDateStr,
  getTelemetryHotCutoffTs,
  queryReadingsRangeAll,
  queryReadingsRange,
  queryEnergy5minRangeAll,
  queryEnergy5minRange,
  // v2.10.4 — chunked-source helpers for yield-friendly export reads.
  listReadingsRangeSources,
  listEnergy5minRangeSources,
  readingsNaturalKey,
  energyNaturalKey,
  sumEnergy5minByInverterRange,
  recoverTodayEnergyFromReadings,
  countDistinctReadingBuckets,
  getLatestReadingDate,
  queryAlarmsRangeArchiveAware,
  findAlarmByIdArchiveAware,
  queryAuditRangeArchiveAware,
  findStopReasonByIdArchiveAware,
  findStopReasonByAlarmIdArchiveAware,
  archiveStopReasonsBeforeCutoff,
  archiveTableBeforeCutoff,
  _resetArchiveCachesForTest,
  archiveReadingsRows,
  archiveEnergyRows,
  getDailyReadingsSummaryRows,
  ingestDailyReadingsSummary,
  rebuildDailyReadingsSummaryForDate,
  markDailyUnitsFinal,
  getFinalizedDailySummaryRange,
  getDailyRunningSummaryRange,
  closeArchiveDbForMonth,
  getArchiveCacheStats,
  evictLruArchiveEntries,
  prepareArchiveDbForTransfer,
  createSqliteTransferSnapshot,
  disposeSqliteTransferSnapshot,
  upsertDailyReportRowsToSnapshot,
  stagePendingMainDbReplacement,
  discardPendingMainDbReplacement,
  readPendingMainDbReplacement,
  beginArchiveDbReplacement,
  endArchiveDbReplacement,
  validateSqliteFileSync,
  insertChatMessage,
  getChatThread,
  getChatInboxAfterId,
  getLatestChatInboundId,
  markChatReadUpToId,
  clearAllChatMessages,
  getScheduledMaintenance,
  insertScheduledMaintenance,
  deleteScheduledMaintenance,
  upsertAvailability5min: (ts, onlineCount, expectedCount) =>
    stmts.upsertAvailability5min.run(ts, onlineCount, expectedCount),
  getAvailability5minRange: (startTs, endTs) =>
    stmts.getAvailability5minRange.all(startTs, endTs),
  // v2.9.0 Slice B/D — counter + clock-sync helpers
  persistCounterState,
  getCounterHistory,
  evaluateCounterAdvancing,
  getCounterBaselinesForDate,
  getYesterdaySnapshotForDate,
  getCounterStateAll,
  getCounterStateOne,
  getTodayBaselineCached,
  invalidateBaselineCache,
  computeTodayHardwareEnergy,
  computeInverterDailyHwTotals,
  insertClockSyncLogRow,
  getClockSyncLog,
  // v2.9.2 — generic audit writer used by poller spike clamps
  insertAuditLogRow,
  // v2.11.0 Active Power Control
  upsertCurtailmentState,
  insertRampLog,
  getApcState,
  markStaleRampsAborted,
  pruneRampLog,
  // v2.11.0 IGBT Health Phase 2.1 — thermal baseline
  upsertIgbtThermalBaseline,
  getIgbtThermalBaselineRange,
  getIgbtThermalBaselineDateSet,
  get5minParamRowsForDay,
  getRecent5MinParamForUnbalance,
  dayHadAgingStopEvent,
  pruneIgbtThermalBaseline,
  IGBT_AGING_MOTIVE_CODES,
  // v2.11.x Slice κ.3 — critical-pattern auto-block ledger
  getActiveCriticalBlock,
  getAllActiveCriticalBlocks,
  getCriticalBlockHistory,
  getLatestAckedCriticalBlock,
  insertCriticalBlock,
  updateCriticalBlockReenforcement,
  updateCriticalBlockPattern,
  ackCriticalBlock,
  // Slice κ.9 — solar-window deferred (armed→active) auto-block
  getPendingCriticalBlock,
  getAllPendingCriticalBlocks,
  armOrRefreshPendingCriticalBlock,
  activatePendingCriticalBlock,
  disarmPendingCriticalBlock,
  // v2.11.x Field Calibration (Phases 2-4) — write log + snapshots + sessions
  insertCalibrationSnapshot,
  getLatestCalibrationSnapshot,
  listCalibrationSnapshots,
  getCalibrationSnapshotById,
  deleteCalibrationSnapshotById,
  insertCalibrationWriteLog,
  listCalibrationWriteLog,
  insertCalibrationSession,
  updateCalibrationSessionEnd,
  getCalibrationSession,
  listRecentCalibrationSessions,
  // v2.11.0 Plant Controller — NGCP compliance run helpers
  insertComplianceRun,
  finalizeComplianceRun,
  listComplianceRuns,
  getComplianceRun,
  appendComplianceStep,
  listComplianceSteps,
  appendComplianceSample,
  listComplianceSamples,
  countComplianceSamples,
  appendComplianceArtifact,
  listComplianceArtifacts,
  // v2.11.0 Plant Controller — APC verification (Slice δ)
  insertApcVerifyLog,
  getLatestApcVerify,
  getLatestApcVerifyAll,
  pruneApcVerifyLog,
  // v2.11.x Phase 3 — Grid-control verification (Slice ζ)
  insertGridControlVerifyLog,
  getLatestGridControlVerify,
  getLatestGridControlVerifyAll,
  pruneGridControlVerifyLog,
};
