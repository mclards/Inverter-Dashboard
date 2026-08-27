"use strict";
/**
 * cloudBackup.js — Local-first cloud backup/restore service.
 *
 * Architecture: Local-first + cloud sync.
 * - All backups are created locally first (guaranteed consistency via SQLite online backup API).
 * - Cloud upload is a best-effort secondary step (retried on failure).
 * - Restore always reads from local backup packages; cloud pull fetches to local first.
 *
 * Backup package format (directory):
 *   cloud_backups/<id>/
 *     manifest.json       checksums, metadata, scope, version
 *     adsi.db             SQLite snapshot (scope: database)
 *     ipconfig.json       inverter IP config (scope: config)
 *     settings.json       app settings export (scope: config)
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cron = require("node-cron");
const fetch = require("node-fetch");
// v2.8.14 (post-1st-release): switched away from PowerShell Compress-Archive
// because Windows PowerShell 5.1's implementation refuses any source >2 GiB
// (`File size (...) is greater than 2 GiB`).  `archiver` writes Zip64 zips
// natively (no 2 GiB / 4 GiB cap) and does NOT block the Node event loop
// the way `execFileSync` did — fixes the export-fail AND the wizard freeze.
// The contained yauzl reader supports Zip64 while rejecting links and escapes.
const archiver = require("archiver");
const { safeExtractZip } = require("./safeZipExtract");

const APP_VERSION = require("../package.json").version;
const { resolvedBackupDir, resolvedBackupHistoryFile, resolvedLicenseDir, getNewRoot } = require("./storagePaths");
const DB_SCHEMA_VERSION = "2";

// BR-Mi3 (audit 2026-05-28 §3) — package layout version, independent of the
// DB schema version and the app version. Bumped only when the on-disk backup
// package structure changes in a way an older app cannot read. A backup whose
// format is newer than this app understands is refused on restore.
const BACKUP_FORMAT_VERSION = 1;

// Limit how many local backup packages to keep.
const MAX_LOCAL_PACKAGES = 20;
const S3_DEDUPE_LAYOUT = "chunked-v1";
const S3_DEDUPE_CHUNK_BYTES = 8 * 1024 * 1024;

// BR-M1 (audit 2026-05-28 §3) — inline retry-with-backoff for transient cloud
// upload failures (429 / 5xx / connection resets / DNS / timeouts). This is a
// fast same-cycle retry; the slower 5-minute deferred queue (_scheduleRetry)
// remains as the outer fallback once these attempts are exhausted.
const UPLOAD_RETRY_MAX = 3;
const UPLOAD_RETRY_BASE_MS = 1000;
const UPLOAD_RETRY_CAP_MS = 30000;

// BR-M2 (audit 2026-05-28 §3) — observability watchdog ceiling for a single
// mutex-held op. With every cloud request now timeout-bounded (BR-M3) an op
// can no longer hang the queue forever, so this is a loud warning, not a
// forced abort (force-aborting mid-flight would break the serial guarantee).
const BACKUP_OP_WATCHDOG_MS = 10 * 60 * 1000;

function sha256File(filePath) {
  // v2.8.14 hotfix: original implementation used fs.readFileSync, which
  // caps at Node's ~2 GiB Buffer ceiling and threw
  //   `RangeError [ERR_FS_FILE_TOO_LARGE]: File size (...) is greater than 2 GiB`
  // for any plant DB or archive that grew past the limit. Use a streamed
  // hash instead — works for arbitrarily large files in constant memory.
  // Sync API kept so callers don't need to ripple async through the call
  // chain (manifest checksum collection is already sync-batched).
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024); // 1 MiB chunks
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead > 0) hash.update(buf.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listFilesRecursive(rootDir) {
  const out = [];
  const walk = (absDir, relBase) => {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(absDir, e.name);
      const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile()) {
        out.push(rel.replace(/\\/g, "/"));
      }
    }
  };
  walk(rootDir, "");
  return out;
}

function copyDirRecursive(srcDir, destDir) {
  if (!srcDir || !fs.existsSync(srcDir)) return false;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  return true;
}

function semverCompare(a, b) {
  const parse = (v) =>
    String(v || "")
      .split(".")
      .map((x) => Number.parseInt(String(x).replace(/[^0-9].*$/, ""), 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
      .slice(0, 3);
  const va = parse(a);
  const vb = parse(b);
  while (va.length < 3) va.push(0);
  while (vb.length < 3) vb.push(0);
  for (let i = 0; i < 3; i++) {
    if (va[i] > vb[i]) return 1;
    if (va[i] < vb[i]) return -1;
  }
  return 0;
}

class CloudBackupService {
  /**
   * @param {object} deps
   * @param {string} deps.dataDir          DATA_DIR from db.js
   * @param {object} deps.db               better-sqlite3 db instance
   * @param {object} deps.getSetting       getSetting fn from db.js
   * @param {object} deps.setSetting       setSetting fn from db.js
   * @param {object} deps.tokenStore       TokenStore instance
   * @param {object} deps.onedrive         OneDriveProvider instance
   * @param {object} deps.gdrive           GDriveProvider instance
   * @param {object} deps.s3               S3CompatibleProvider instance
   * @param {object} deps.poller           poller module (optional, for stop/start around restore)
   * @param {string} deps.ipConfigPath     Path to ipconfig.json (for config scope backup)
   * @param {string} deps.programDataDir   ProgramData root for forecast artifacts
   */
  constructor(deps) {
    this.dataDir = deps.dataDir;
    this.archiveDir = deps.archiveDir || path.join(getNewRoot(), "archive");
    this.db = deps.db;
    this.getSetting = deps.getSetting;
    this.setSetting = deps.setSetting;
    this.tokenStore = deps.tokenStore;
    this.onedrive = deps.onedrive;
    this.gdrive = deps.gdrive;
    this.s3 = deps.s3;
    this.poller = deps.poller || null;
    this.ipConfigPath = deps.ipConfigPath || null;
    this.programDataDir = deps.programDataDir || null;
    // v2.8.14: optional persistent health tracker. When present, every backup
    // attempt (Tier 3 cloud, manual/scheduled .adsibak, restore) records its
    // outcome so the admin panel can render "Last success" + alert badges.
    this.healthRegistry = deps.healthRegistry || null;

    // v2.8.9 fix (2026-04-15): honour an explicit `backupDir` / `historyFile`
    // override if the caller supplies one.  Previously `resolvedBackupDir()`
    // silently fell back to `%PROGRAMDATA%\InverterDashboard\cloud_backups`
    // whenever that directory existed on the machine — correct for
    // production, but for tests running on a developer machine with a real
    // installation, the service wrote into the REAL backup dir while the
    // test read from its tmpdir, producing ENOENT.  Tests now pass
    // `backupDir: <tmpdir>/cloud_backups` and the override short-circuits
    // the fallback logic.
    this.backupDir = deps.backupDir || resolvedBackupDir(this.dataDir);
    this.historyFile = deps.historyFile || resolvedBackupHistoryFile(this.dataDir);

    fs.mkdirSync(this.backupDir, { recursive: true });

    this.history = this._loadHistory();
    this._cronJob = null;
    // v2.8.14 R1: separate cron job for the scheduled portable .adsibak export
    // so it can run independently of the cloud upload schedule.
    this._localCronJob = null;
    this._retryQueue = [];
    this._retryTimer = null;

    // T2.2 fix: single-writer mutex.  Serialises every public backup /
    // restore entry point so a simultaneous backup-upload and restore can't
    // race on `this.db.backup()` and corrupt the database or manifest.
    // Internal helpers (e.g. the pre-restore safety backup inside
    // restoreBackup) run *within* the already-held lock and must therefore
    // call `createLocalBackup` directly — not go through _withBackupMutex.
    this._backupOpChain = Promise.resolve();

    this.progress = {
      status: "idle", // idle | creating | uploading | restoring | pulling | error | done
      pct: 0,
      message: "",
      provider: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: null,
      error: null,
    };
  }

  // ─── Concurrency ──────────────────────────────────────────────────────────

  /**
   * T2.2 fix: run `fn` with exclusive access to the backup subsystem.
   * Public entry points (`backupNow`, `pullFromCloud`, `restoreBackup`,
   * `restorePortableBackup`, `createPortableBackup`, `importPortableBackup`)
   * should wrap their body in this helper.  The mutex is a promise-chain:
   * each caller awaits the previous (success OR failure) before running.
   * Internal helpers invoked from within an already-held section must NOT
   * re-enter this helper — they would deadlock.
   */
  async _withBackupMutex(label, fn) {
    // The mutex is a promise-chain: each caller awaits the previous (success OR
    // failure — note the `() => next, () => next` two-arm `.then`) before
    // running, then resolves `next` in its own `finally` so the next caller
    // proceeds. This guarantees strict serialisation with NO starvation —
    // every queued op eventually runs. It is NOT a deadlock setup (BR-D2).
    const prev = this._backupOpChain;
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    this._backupOpChain = prev.then(() => next, () => next);
    let watchdog = null;
    const startedAt = Date.now();
    try {
      await prev.catch(() => {});
      // BR-M2 watchdog — see BACKUP_OP_WATCHDOG_MS note. Warn (don't abort) so
      // a genuinely stuck op is visible rather than silent. unref() so it
      // never holds the process open.
      watchdog = setTimeout(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const msg = `[CloudBackup] mutex op "${label}" still running after ${secs}s ` +
          `(watchdog ${Math.round(BACKUP_OP_WATCHDOG_MS / 1000)}s) — possible stuck upload/restore`;
        console.warn(msg);
        // Diagnostic only — do NOT record a health-registry failure here; the
        // op may still complete successfully. Surfaced via getProgress().
        this._lastSlowOp = { label, runningSecs: secs, at: Date.now() };
      }, BACKUP_OP_WATCHDOG_MS);
      if (watchdog.unref) watchdog.unref();
      return await fn();
    } finally {
      if (watchdog) clearTimeout(watchdog);
      release();
    }
  }

  // ─── Restore destination probe (v2.8.14) ─────────────────────────────────
  // Probe every directory the restore is about to write to. Fail loud + early
  // if any is read-only, rather than crashing partway through and triggering
  // the auto-rollback chain into the same broken directories.
  _probeWritable(dirPath) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      const probe = path.join(dirPath, `.restore-probe-${process.pid}`);
      fs.writeFileSync(probe, "");
      fs.unlinkSync(probe);
      return null;
    } catch (err) {
      return err.message || String(err);
    }
  }

  _assertRestoreDestinationsWritable(manifest, scopeFilter) {
    const scope = Array.isArray(manifest?.scope) ? manifest.scope : [];
    const targets = [];
    const allow = (s) => scope.includes(s) && this._scopeAllowed(s, scopeFilter);

    if (allow("database")) {
      targets.push({ label: "database directory", path: this.dataDir });
      if (this.programDataDir) {
        targets.push({ label: "forecast directory", path: path.join(this.programDataDir, "forecast") });
        targets.push({ label: "history directory", path: path.join(this.programDataDir, "history") });
        targets.push({ label: "weather directory", path: path.join(this.programDataDir, "weather") });
      }
    }
    if (allow("config") && this.ipConfigPath) {
      targets.push({ label: "config directory", path: path.dirname(this.ipConfigPath) });
    }
    if (allow("logs")) {
      targets.push({ label: "server logs directory", path: path.join(this.dataDir, "logs") });
      if (this.programDataDir) {
        targets.push({ label: "ProgramData logs directory", path: path.join(this.programDataDir, "logs") });
      }
    }
    if (allow("archive") && this.programDataDir) {
      targets.push({ label: "archive directory", path: path.join(this.programDataDir, "archive") });
    }
    if (allow("license")) {
      try {
        // resolvedLicenseDir is already destructured at the top of this file.
        // The try/catch guards against the rare case where the function itself
        // throws (e.g. legacy install pointing at a now-unmounted drive).
        targets.push({ label: "license directory", path: resolvedLicenseDir() });
      } catch (_) {
        /* license scope skipped if path can't be resolved */
      }
    }
    if (allow("auth") && this.programDataDir) {
      targets.push({ label: "auth directory", path: path.join(this.programDataDir, "auth") });
    }

    const failures = [];
    for (const t of targets) {
      if (!t.path) continue;
      const err = this._probeWritable(t.path);
      if (err) failures.push(`${t.label} (${t.path}): ${err}`);
    }
    if (failures.length) {
      throw new Error(
        "Restore aborted — one or more destination directories are not writable. " +
        "On Windows this usually means %PROGRAMDATA%\\InverterDashboard requires " +
        "an ACL grant; try running the dashboard once as administrator, or run " +
        `'icacls "%PROGRAMDATA%\\InverterDashboard" /grant Users:(OI)(CI)M /T'. ` +
        `Failures: ${failures.join("; ")}`,
      );
    }
  }

  // ─── Mode gate (v2.8.14) ──────────────────────────────────────────────────
  // Local backups only make sense on the gateway. In remote mode the local DB
  // is an in-memory replica of the gateway's data, so any backup would silently
  // capture stale or absent state. Cron callbacks check this before doing work.
  _isRemoteMode() {
    try {
      const v = String(this.getSetting("operationMode", "gateway") || "gateway")
        .trim().toLowerCase();
      return v === "remote";
    } catch {
      return false;
    }
  }

  // ─── Archive helpers (v2.8.14 hotfix) ─────────────────────────────────────
  // PowerShell Compress-Archive on Windows PowerShell 5.1 refuses any source
  // larger than ~2 GiB and the .NET shim on PS5.1 doesn't enable Zip64 for
  // writes.  Real plant DBs hit that ceiling within months. archiver writes
  // Zip64 natively (no 2 GiB / 4 GiB cap) and runs as a Node stream so we
  // also stop blocking the event loop the way execFileSync did.
  //
  // For READING (`importPortableBackup`, `validatePortableBackup`) we use
  // The contained yauzl extractor understands Zip64 archives transparently.

  /**
   * Stream-zip the contents of `srcDir` into `destZip`.  Returns the number
   * of compressed bytes written. Internally enables Zip64 automatically when
   * the archive grows past the 32-bit zip thresholds, so .adsibak files can
   * scale to whatever the disk holds.
   *
   * `onProgress(processed, total)` is called periodically with bytes-so-far.
   * `total` is best-effort — archiver only knows totals for entries already
   * queued, so it grows over the run.
   */
  async _zipDirectory(srcDir, destZip, onProgress) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destZip);
      const archive = archiver("zip", {
        zlib: { level: 6 },
        // archiver auto-enables Zip64 when an archive or entry crosses the
        // 32-bit thresholds.  We do NOT pass `forceZip64: true` so small
        // backups stay max-compatible with stock unzip tools.
      });

      let settled = false;
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        try { archive.abort(); } catch (_) {}
        try { output.destroy(); } catch (_) {}
        try { fs.unlinkSync(destZip); } catch (_) {}
        reject(err);
      };

      output.on("close", () => {
        if (settled) return;
        settled = true;
        resolve(archive.pointer());
      });
      output.on("error", settleErr);
      archive.on("error", settleErr);

      // ENOENT for individual sub-files is non-fatal (e.g., a log file
      // rotated mid-zip). Anything else is fatal.
      archive.on("warning", (err) => {
        if (err && err.code === "ENOENT") {
          console.warn("[CloudBackup] zip warning (ignored):", err.message);
        } else {
          settleErr(err);
        }
      });

      if (typeof onProgress === "function") {
        archive.on("progress", (p) => {
          try {
            onProgress(
              Number(p?.fs?.processedBytes || 0),
              Number(p?.fs?.totalBytes || 0),
            );
          } catch (_) { /* ignore listener errors */ }
        });
      }

      archive.pipe(output);
      // false = don't include the source directory name in the archive
      // (matches PowerShell `Compress-Archive -Path 'dir\*'` behaviour).
      archive.directory(srcDir, false);
      archive.finalize().catch(settleErr);
    });
  }

  /**
   * Extract `srcZip` into `destDir`, creating destDir if needed.  Honours
   * Zip64 transparently. Async — does NOT block the event loop.
   *
   * The contained reader rejects absolute paths, traversal, symlinks, and
   * excessive expansion before writing archive entries.
   */
  async _extractZip(srcZip, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    await safeExtractZip(srcZip, { dir: path.resolve(destDir) });
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  getDefaultSettings() {
    return {
      enabled: false,
      email: "",
      provider: "auto",              // auto | onedrive | gdrive | s3 | both
      scope: ["database", "config"], // database | config | logs
      schedule: "manual",            // manual | daily | every6h
      onedrive: { clientId: "" },
      gdrive: { clientId: "", clientSecret: "" },
      s3: {
        endpoint: "",
        region: "",
        bucket: "",
        prefix: "InverterDashboardBackups",
        forcePathStyle: false,
      },
    };
  }

  getCloudSettings() {
    const raw = this.getSetting("cloudBackupSettings", null);
    const defaults = this.getDefaultSettings();
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        onedrive: {
          ...defaults.onedrive,
          ...(parsed?.onedrive && typeof parsed.onedrive === "object"
            ? parsed.onedrive
            : {}),
        },
        gdrive: {
          ...defaults.gdrive,
          ...(parsed?.gdrive && typeof parsed.gdrive === "object"
            ? parsed.gdrive
            : {}),
        },
        s3: {
          ...defaults.s3,
          ...(parsed?.s3 && typeof parsed.s3 === "object"
            ? parsed.s3
            : {}),
        },
      };
    } catch {
      return defaults;
    }
  }

  getCloudSettingsForClient(settings = null) {
    const source = settings && typeof settings === "object"
      ? settings
      : this.getCloudSettings();
    const secret = String(source?.gdrive?.clientSecret || "").trim();
    return {
      ...source,
      onedrive: {
        ...(source?.onedrive || {}),
      },
      gdrive: {
        ...(source?.gdrive || {}),
        clientSecret: "",
        clientSecretSaved: secret.length > 0,
      },
      s3: {
        ...(source?.s3 || {}),
        accessKeyId: "",
        secretAccessKey: "",
        credentialsSaved: this.tokenStore.isConnected("s3"),
      },
    };
  }

  saveCloudSettings(s, options = {}) {
    const current = this.getCloudSettings();
    const body = s && typeof s === "object" ? s : {};
    const clearGDriveClientSecret = Boolean(options?.clearGDriveClientSecret);
    const incomingOneDrive = {
      clientId: String(body?.onedrive?.clientId ?? ""),
    };
    const incomingGDrive = {
      clientId: String(body?.gdrive?.clientId ?? ""),
      clientSecret: String(body?.gdrive?.clientSecret ?? ""),
    };
    const incomingS3 = {
      endpoint: String(body?.s3?.endpoint ?? "").trim(),
      region: String(body?.s3?.region ?? "").trim(),
      bucket: String(body?.s3?.bucket ?? "").trim(),
      prefix: String(body?.s3?.prefix ?? "").trim(),
      forcePathStyle: Boolean(body?.s3?.forcePathStyle),
    };
    const merged = {
      ...current,
      ...body,
      onedrive: {
        ...(current.onedrive || {}),
        ...incomingOneDrive,
      },
      gdrive: {
        ...(current.gdrive || {}),
        ...incomingGDrive,
      },
      s3: {
        ...(current.s3 || {}),
        ...incomingS3,
      },
    };
    const nextSecret = String(incomingGDrive.clientSecret ?? "").trim();
    if (clearGDriveClientSecret) {
      merged.gdrive.clientSecret = "";
    } else if (nextSecret) {
      merged.gdrive.clientSecret = nextSecret;
    } else {
      merged.gdrive.clientSecret = String(current.gdrive?.clientSecret || "");
    }
    // Validate provider
    if (!["auto", "onedrive", "gdrive", "s3", "both"].includes(merged.provider)) {
      merged.provider = "auto";
    }
    if (!["manual", "daily", "every6h"].includes(merged.schedule)) {
      merged.schedule = "manual";
    }
    this.setSetting("cloudBackupSettings", JSON.stringify(merged));
    this._applySchedule(merged.schedule, merged.enabled);
    return merged;
  }

  _getProviderAdapter(provider) {
    if (provider === "onedrive") return this.onedrive;
    if (provider === "gdrive") return this.gdrive;
    if (provider === "s3") return this.s3;
    return null;
  }

  // ─── Progress ─────────────────────────────────────────────────────────────

  _setProgress(update) {
    Object.assign(this.progress, update, { updatedAt: Date.now() });
  }

  getProgress() {
    return { ...this.progress };
  }

  // ─── History ──────────────────────────────────────────────────────────────

  _loadHistory() {
    try {
      if (!fs.existsSync(this.historyFile)) return [];
      return JSON.parse(fs.readFileSync(this.historyFile, "utf8")) || [];
    } catch {
      return [];
    }
  }

  _saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    } catch (err) {
      console.error("[CloudBackup] Failed to save history:", err.message);
    }
  }

  _addHistoryEntry(entry) {
    this.history.unshift(entry);
    // Keep max 200 history entries.
    if (this.history.length > 200) this.history.length = 200;
    this._saveHistory();
  }

  getHistory() {
    return [...this.history];
  }

  async _recordFilesFromDir(dir, relPrefix, checksums, files) {
    if (!dir || !fs.existsSync(dir)) return;
    let _sinceYield = 0;
    for (const rel of listFilesRecursive(dir)) {
      const abs = path.join(dir, ...rel.split("/"));
      const outRel = relPrefix ? `${relPrefix}/${rel}` : rel;
      checksums[outRel] = sha256File(abs);
      files.push({ name: outRel, size: fs.statSync(abs).size });
      // Yield to the event loop periodically. SHA-256-hashing a large
      // forecast/history/weather/archive tree was fully synchronous and could
      // stall the API + poller for seconds during a (possibly daytime, manual)
      // backup. Hashing stays synchronous per file; we just hand the loop a
      // breather every 50 files. (2026-06-01 freeze hardening.)
      if ((++_sinceYield % 50) === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  _getS3ChunkKey(chunkHash) {
    return `objects/chunks/${String(chunkHash || "").slice(0, 2)}/${chunkHash}`;
  }

  async _uploadS3DeduplicatedBackup(dir, backupId, manifest, adapter) {
    if (
      typeof adapter?.objectExists !== "function" ||
      typeof adapter?.uploadBuffer !== "function"
    ) {
      throw new Error("S3 adapter does not support deduplicated backup uploads");
    }

    const manifestPath = path.join(dir, "manifest.json");
    const allFiles = listFilesRecursive(dir).filter((fname) => fname !== "manifest.json");
    if (!allFiles.length) {
      throw new Error("No files found in backup package");
    }

    const totalBytes = allFiles.reduce((sum, fname) => {
      const localPath = path.join(dir, ...fname.split("/"));
      return sum + Number(fs.statSync(localPath).size || 0);
    }, 0);
    const knownChunks = new Set();
    const cloudFiles = {};
    let processedBytes = 0;
    let uploadedBytes = 0;
    let reusedBytes = 0;

    for (const fname of allFiles) {
      const localPath = path.join(dir, ...fname.split("/"));
      const fileSize = Number(fs.statSync(localPath).size || 0);
      const fileChecksum = String(manifest?.checksums?.[fname] || sha256File(localPath));
      const fileMeta = {
        format: S3_DEDUPE_LAYOUT,
        size: fileSize,
        checksum: fileChecksum,
        chunks: [],
      };

      if (fileSize > 0) {
        const fd = fs.openSync(localPath, "r");
        try {
          let offset = 0;
          while (offset < fileSize) {
            const bytesToRead = Math.min(S3_DEDUPE_CHUNK_BYTES, fileSize - offset);
            const buffer = Buffer.allocUnsafe(bytesToRead);
            const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, offset);
            if (!(bytesRead > 0)) break;
            const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
            const chunkHash = sha256Buffer(chunk);
            const chunkKey = this._getS3ChunkKey(chunkHash);
            let chunkExists = knownChunks.has(chunkKey);
            if (!chunkExists) {
              chunkExists = await adapter.objectExists(chunkKey);
              if (!chunkExists) {
                await adapter.uploadBuffer(chunk, chunkKey);
                uploadedBytes += chunk.length;
              } else {
                reusedBytes += chunk.length;
              }
              knownChunks.add(chunkKey);
            } else {
              reusedBytes += chunk.length;
            }
            fileMeta.chunks.push({
              id: chunkKey,
              sha256: chunkHash,
              size: chunk.length,
            });
            processedBytes += chunk.length;
            const ratio = totalBytes > 0 ? processedBytes / totalBytes : 1;
            this._setProgress({
              pct: Math.min(95, 75 + Math.round(ratio * 18)),
            });
            offset += chunk.length;
          }
        } finally {
          fs.closeSync(fd);
        }
      }

      cloudFiles[fname] = fileMeta;
    }

    manifest.cloud.s3 = {
      uploadedAt: new Date().toISOString(),
      layout: S3_DEDUPE_LAYOUT,
      chunkBytes: S3_DEDUPE_CHUNK_BYTES,
      uploadedBytes,
      reusedBytes,
      files: cloudFiles,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const manifestResult = await adapter.uploadFile(
      manifestPath,
      `${backupId}/manifest.json`,
      (pct) => {
        this._setProgress({
          pct: Math.min(95, 93 + Math.round((Number(pct || 0) / 100) * 2)),
        });
      },
    );
    manifest.cloud.s3.manifest = manifestResult;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    await adapter.uploadFile(manifestPath, `${backupId}/manifest.json`);
    return cloudFiles;
  }

  async _downloadS3ChunkedFile(adapter, localPath, meta, onChunk) {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const chunks = Array.isArray(meta?.chunks) ? meta.chunks : [];
    if (!chunks.length) {
      fs.writeFileSync(localPath, Buffer.alloc(0));
      return;
    }

    const fd = fs.openSync(localPath, "w");
    try {
      for (const chunkMeta of chunks) {
        const chunkId = String(chunkMeta?.id || "").trim();
        if (!chunkId) continue;
        const data = await adapter.downloadBuffer(chunkId);
        const expectedHash = String(chunkMeta?.sha256 || "").trim();
        if (expectedHash && sha256Buffer(data) !== expectedHash) {
          throw new Error(`Checksum mismatch while restoring chunk for ${path.basename(localPath)}`);
        }
        fs.writeSync(fd, data, 0, data.length);
        if (typeof onChunk === "function") onChunk(chunkMeta, data.length);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // ─── Local Backup Creation ─────────────────────────────────────────────────

  /**
   * Create a local backup package.
   * @param {object} opts
   * @param {string[]} opts.scope   e.g. ["database","config"]
   * @param {string}   [opts.tag]  Optional label (e.g. "manual-2026-03-04")
   * @returns {Promise<{id, dir, manifest}>}
   */
  async createLocalBackup(opts = {}) {
    const scope = Array.isArray(opts.scope)
      ? opts.scope
      : ["database", "config"];
    const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
    const id = `inverter-backup-${nowIso}`;
    const dir = path.join(this.backupDir, id);
    fs.mkdirSync(dir, { recursive: true });

    this._setProgress({
      status: "creating",
      pct: 5,
      message: "Creating local backup package…",
      startedAt: Date.now(),
      error: null,
    });

    const checksums = {};
    const files = [];

    // ── Database scope ──
    if (scope.includes("database")) {
      const dbDest = path.join(dir, "adsi.db");
      this._setProgress({ pct: 15, message: "Backing up database…" });
      // BR-Mi1 (audit 2026-05-28 §3) — `db.backup()` is SQLite's online-backup
      // API: it produces a transactionally-consistent snapshot that already
      // includes WAL-resident pages, so the package needs no separate
      // -wal/-shm files. We still fold the WAL back into the main file first
      // (best-effort PASSIVE checkpoint — non-blocking, never waits on readers)
      // so the snapshot is as compact and current as possible.
      try {
        this.db.pragma("wal_checkpoint(PASSIVE)");
      } catch (err) {
        console.warn("[CloudBackup] pre-backup WAL checkpoint skipped:", err.message);
      }
      await this.db.backup(dbDest);
      checksums["adsi.db"] = sha256File(dbDest);
      files.push({ name: "adsi.db", size: fs.statSync(dbDest).size });
      const forecastDir = this.programDataDir
        ? path.join(this.programDataDir, "forecast")
        : null;
      const historyDir = this.programDataDir
        ? path.join(this.programDataDir, "history")
        : null;
      const weatherDir = this.programDataDir
        ? path.join(this.programDataDir, "weather")
        : null;
      const forecastDest = path.join(dir, "forecast");
      const historyDest = path.join(dir, "history");
      const weatherDest = path.join(dir, "weather");
      if (forecastDir && copyDirRecursive(forecastDir, forecastDest)) {
        await this._recordFilesFromDir(forecastDest, "forecast", checksums, files);
      }
      if (historyDir && copyDirRecursive(historyDir, historyDest)) {
        await this._recordFilesFromDir(historyDest, "history", checksums, files);
      }
      if (weatherDir && copyDirRecursive(weatherDir, weatherDest)) {
        await this._recordFilesFromDir(weatherDest, "weather", checksums, files);
      }
    }

    // ── Config scope ──
    if (scope.includes("config")) {
      this._setProgress({ pct: 40, message: "Backing up config files…" });

      // IP config
      if (this.ipConfigPath && fs.existsSync(this.ipConfigPath)) {
        const dest = path.join(dir, "ipconfig.json");
        fs.copyFileSync(this.ipConfigPath, dest);
        checksums["ipconfig.json"] = sha256File(dest);
        files.push({ name: "ipconfig.json", size: fs.statSync(dest).size });
      }

      // Export current settings from DB as JSON
      try {
        const settingsExport = this._exportSettingsJson();
        const dest = path.join(dir, "settings.json");
        fs.writeFileSync(dest, JSON.stringify(settingsExport, null, 2));
        checksums["settings.json"] = sha256File(dest);
        files.push({ name: "settings.json", size: fs.statSync(dest).size });
      } catch (err) {
        console.warn("[CloudBackup] Settings export failed:", err.message);
      }
    }

    // ── Logs scope ──
    if (scope.includes("logs")) {
      this._setProgress({ pct: 55, message: "Backing up logs…" });
      const logsDir = path.join(this.dataDir, "logs");
      if (fs.existsSync(logsDir)) {
        const logDest = path.join(dir, "logs");
        fs.mkdirSync(logDest, { recursive: true });
        for (const f of fs.readdirSync(logsDir).slice(-50)) { // last 50 log files max
          const src = path.join(logsDir, f);
          const dst = path.join(logDest, f);
          try {
            fs.copyFileSync(src, dst);
            checksums[`logs/${f}`] = sha256File(dst);
            files.push({ name: `logs/${f}`, size: fs.statSync(dst).size });
          } catch {
            // skip unreadable log files
          }
        }
      }
      const forecastLogSrc = this.programDataDir
        ? path.join(this.programDataDir, "logs", "forecast_dayahead.log")
        : null;
      if (forecastLogSrc && fs.existsSync(forecastLogSrc)) {
        const logDest = path.join(dir, "logs");
        fs.mkdirSync(logDest, { recursive: true });
        const dst = path.join(logDest, "forecast_dayahead.log");
        fs.copyFileSync(forecastLogSrc, dst);
        checksums["logs/forecast_dayahead.log"] = sha256File(dst);
        files.push({ name: "logs/forecast_dayahead.log", size: fs.statSync(dst).size });
      }

      // v2.8.14 R6: explicitly include recovery.log even if it would otherwise
      // be dropped by the slice(-50) above. The recovery log is the primary
      // diagnostic trail when a power-loss event triggers the integrity gate;
      // losing it on a portable migration defeats post-mortem analysis.
      //
      // Path note: recovery.log is written by electron/recoveryDialog.js to
      // <programDataDir>/logs/recovery.log (i.e. %PROGRAMDATA%\InverterDashboard
      // \logs\recovery.log), NOT under dataDir/logs (which is …\InverterDashboard
      // \db\logs). Check programDataDir first, fall back to dataDir for any
      // legacy installs that placed it under the DB tree.
      const recoveryLogCandidates = [];
      if (this.programDataDir) {
        recoveryLogCandidates.push(path.join(this.programDataDir, "logs", "recovery.log"));
      }
      recoveryLogCandidates.push(path.join(this.dataDir, "logs", "recovery.log"));
      for (const recoveryLogSrc of recoveryLogCandidates) {
        if (fs.existsSync(recoveryLogSrc) && !checksums["logs/recovery.log"]) {
          const logDest = path.join(dir, "logs");
          fs.mkdirSync(logDest, { recursive: true });
          const dst = path.join(logDest, "recovery.log");
          try {
            fs.copyFileSync(recoveryLogSrc, dst);
            checksums["logs/recovery.log"] = sha256File(dst);
            files.push({ name: "logs/recovery.log", size: fs.statSync(dst).size });
            break;
          } catch (err) {
            console.warn("[CloudBackup] recovery.log copy failed:", err.message);
          }
        }
      }
    }

    const totalSize = files.reduce((s, f) => s + f.size, 0);

    // v2.8.14 R3: capture row counts from key tables so the restore preview
    // modal can show "N readings will be restored" before the destructive copy.
    // Best-effort — never fails the backup; absence of `rowCounts` is handled
    // gracefully by older clients reading newer backups (and vice versa).
    let rowCounts = null;
    if (scope.includes("database")) {
      try {
        rowCounts = this._collectRowCounts();
      } catch (err) {
        console.warn("[CloudBackup] row count collection failed:", err.message);
      }
    }

    const manifest = {
      id,
      appVersion: APP_VERSION,
      schemaVersion: DB_SCHEMA_VERSION,
      backupFormatVersion: BACKUP_FORMAT_VERSION, // BR-Mi3 — package-layout version
      createdAt: new Date().toISOString(),
      scope,
      tag: opts.tag || "manual",
      checksums,
      files,
      totalSize,
      rowCounts,
      cloud: {},
    };

    // T2.10 fix (Phase 2, 2026-04-14): write manifest atomically via a .tmp
    // file + rename so two concurrent backup runs cannot produce a torn /
    // partially-overwritten manifest.json that would later break restore.
    const manifestPath = path.join(dir, "manifest.json");
    const manifestTmp = `${manifestPath}.tmp`;
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(manifestTmp, manifestPath);
    checksums["manifest.json"] = sha256File(manifestPath);
    manifest.checksums = checksums;
    // Second write embeds the manifest's own checksum — also atomic.
    fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(manifestTmp, manifestPath);

    this._setProgress({ pct: 70, message: "Local backup package created." });

    this._addHistoryEntry({
      id,
      createdAt: manifest.createdAt,
      scope,
      tag: manifest.tag,
      totalSize,
      status: "local",
      cloud: {},
      dir,
    });

    this._pruneOldLocalPackages();
    console.log(`[CloudBackup] Created local package: ${id}`);
    return { id, dir, manifest };
  }

  _exportSettingsJson() {
    // Read settings from DB for backup — excludes sensitive tokens
    const sensitiveKeys = [
      "remoteApiToken", "solcastApiKey", "cloudBackupSettings",
    ];
    const stmts = this.db
      .prepare("SELECT key, value FROM settings")
      .all();
    const obj = {};
    for (const row of stmts) {
      if (!sensitiveKeys.includes(row.key)) {
        obj[row.key] = row.value;
      }
    }
    return obj;
  }

  _pruneOldLocalPackages() {
    try {
      const dirs = fs
        .readdirSync(this.backupDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith("inverter-backup-"))
        .sort((a, b) => a.name.localeCompare(b.name));
      while (dirs.length > MAX_LOCAL_PACKAGES) {
        const oldest = dirs.shift();
        const p = path.join(this.backupDir, oldest.name);
        fs.rmSync(p, { recursive: true, force: true });
        console.log("[CloudBackup] Pruned old package:", oldest.name);
      }
    } catch (err) {
      console.warn("[CloudBackup] Prune failed:", err.message);
    }
  }

  // ─── Cloud Upload ──────────────────────────────────────────────────────────

  /**
   * Upload a local backup package to cloud provider(s).
   * @param {string} backupId  ID of local backup package
   * @param {string[]} providers  ["onedrive","gdrive"] or subset
   */
  async uploadToCloud(backupId, providers = []) {
    const entry = this.history.find((h) => h.id === backupId);
    const dir = entry?.dir || path.join(this.backupDir, backupId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Backup package not found: ${backupId}`);
    }
    const manifestPath = path.join(dir, "manifest.json");
    const manifest = safeReadJson(manifestPath);
    if (!manifest) throw new Error("Backup manifest missing or corrupted");
    if (!this._verifyChecksums(dir, manifest)) {
      throw new Error("Backup package failed checksum verification before upload");
    }

    const errors = [];
    let uploadedCount = 0;
    let retryTotal = 0;

    for (const provider of providers) {
      const adapter = this._getProviderAdapter(provider);
      if (!adapter?.isConnected()) {
        errors.push(`${provider}: not connected`);
        continue;
      }
      this._setProgress({
        status: "uploading",
        pct: 75,
        message: `Uploading to ${provider}…`,
        provider,
      });
      try {
        // BR-M1 — wrap the whole provider upload in retry-with-backoff so a
        // single transient failure (429 / 5xx / reset / DNS / timeout) does not
        // burn the entire backup cycle. Re-running re-uploads all files; every
        // provider uses replace/overwrite semantics so this is idempotent.
        const cloudFiles = await this._retryWithBackoff(`upload→${provider}`, async () => {
          const out = {};
          if (provider === "s3") {
            Object.assign(
              out,
              await this._uploadS3DeduplicatedBackup(dir, backupId, manifest, adapter),
            );
          } else {
            const allFiles = listFilesRecursive(dir);
            if (!allFiles.length) {
              throw new Error("No files found in backup package");
            }
            for (let i = 0; i < allFiles.length; i++) {
              const fname = allFiles[i];
              const localPath = path.join(dir, ...fname.split("/"));
              const remoteName = `${backupId}/${fname}`;
              const result = await adapter.uploadFile(
                localPath,
                remoteName,
                (pct) => {
                  const overall = 75 + Math.round(((i + pct / 100) / allFiles.length) * 20);
                  this._setProgress({ pct: Math.min(overall, 95) });
                },
              );
              out[fname] = result;
            }
          }
          return out;
        });
        retryTotal += this._lastRetryCount || 0;

        if (provider !== "s3") {
          // Update manifest cloud metadata in the local package.
          manifest.cloud[provider] = {
            uploadedAt: new Date().toISOString(),
            files: cloudFiles,
          };
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        }

        // Update history entry.
        if (entry) {
          entry.cloud = entry.cloud || {};
          entry.cloud[provider] = { uploadedAt: new Date().toISOString() };
          entry.status = "cloud";
          this._saveHistory();
        }

        uploadedCount++;
        console.log(`[CloudBackup] Uploaded ${backupId} → ${provider}`);
      } catch (err) {
        console.error(`[CloudBackup] Upload to ${provider} failed:`, err.message);
        errors.push(`${provider}: ${err.message}`);
        // Add to retry queue.
        this._retryQueue.push({ backupId, provider, attempts: 0 });
        this._scheduleRetry();
      }
    }

    if (uploadedCount === 0 && errors.length > 0) {
      throw new Error(`All uploads failed: ${errors.join("; ")}`);
    }
    return { uploaded: uploadedCount, errors, retries: retryTotal };
  }

  /**
   * BR-M1 — classify whether an upload error is worth a fast retry. Transient
   * = rate-limit, server-side 5xx, or a recoverable network condition. A 4xx
   * auth/permission error (other than 429) is NOT retried — it would just fail
   * again identically.
   */
  _isTransientUploadError(err) {
    if (!err) return false;
    const code = String(err.code || err.errno || "").toUpperCase();
    if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ENOTFOUND", "ENETUNREACH", "ABORT_ERR"].includes(code)) {
      return true;
    }
    if (err.name === "AbortError" || err.type === "request-timeout") return true;
    // HTTP status surfaced either as err.status / err.statusCode or in the message.
    const status = Number(err.status || err.statusCode || 0);
    if (status === 429 || (status >= 500 && status <= 599)) return true;
    const msg = String(err.message || "");
    if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
    if (/timeout|timed out|socket hang up|network|temporarily unavailable|throttl/i.test(msg)) return true;
    return false;
  }

  /**
   * BR-M1 — run `fn` with exponential-backoff retry on transient failure.
   * Records the number of retries it took on `this._lastRetryCount` so the
   * caller can fold it into a single health-registry record (avoids
   * double-counting attempts). Non-transient errors throw immediately.
   */
  async _retryWithBackoff(label, fn) {
    this._lastRetryCount = 0;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (attempt > UPLOAD_RETRY_MAX || !this._isTransientUploadError(err)) {
          throw err;
        }
        this._lastRetryCount = attempt;
        // Exponential backoff with full jitter, capped.
        const base = Math.min(UPLOAD_RETRY_CAP_MS, UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 1));
        const delay = Math.round(Math.random() * base);
        console.warn(
          `[CloudBackup] ${label} transient failure (attempt ${attempt}/${UPLOAD_RETRY_MAX}): ` +
            `${err.message}; retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // ─── Full Backup Workflow ──────────────────────────────────────────────────

  /**
   * Run the full backup workflow: create local → upload to cloud.
   * @param {object} opts
   * @param {string[]} opts.scope
   * @param {string}   opts.provider  "auto"|"onedrive"|"gdrive"|"both"
   * @param {string}   [opts.tag]
   */
  async backupNow(opts = {}) {
    // T2.2 fix: serialise via mutex so concurrent backup+restore can't race.
    return this._withBackupMutex("backupNow", () => this._backupNowLocked(opts));
  }

  async _backupNowLocked(opts = {}) {
    if (this.progress.status !== "idle" && this.progress.status !== "done" && this.progress.status !== "error") {
      throw new Error("A backup/restore operation is already in progress");
    }

    this._setProgress({
      status: "creating",
      pct: 0,
      message: "Starting backup…",
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    });

    const startedAt = Date.now();
    try {
      const settings = this.getCloudSettings();
      const scope = opts.scope || settings.scope || ["database", "config"];
      const providerPref = opts.provider || settings.provider || "auto";
      const tag = opts.tag || `manual-${new Date().toISOString().slice(0, 10)}`;

      // Create local backup.
      const { id, manifest } = await this.createLocalBackup({ scope, tag });

      // Resolve upload providers.
      const uploadProviders = this._resolveProviders(providerPref);
      if (uploadProviders.length > 0) {
        const result = await this.uploadToCloud(id, uploadProviders);
        this._setProgress({
          status: "done",
          pct: 100,
          message: `Backup complete. Uploaded to: ${uploadProviders.join(", ")}`,
          finishedAt: Date.now(),
        });
        this.healthRegistry?.recordAttempt("tier3", true, {
          destination: uploadProviders.join(","),
          sizeBytes: manifest?.totalSize || null,
          durationMs: Date.now() - startedAt,
          retries: result.retries || 0, // BR-M1 — transient-retry count this cycle
        });
        return { id, manifest, uploaded: result.uploaded, errors: result.errors };
      } else {
        this._setProgress({
          status: "done",
          pct: 100,
          message: "Local backup created. No cloud providers connected.",
          finishedAt: Date.now(),
        });
        this.healthRegistry?.recordAttempt("tier3", true, {
          destination: "local-only",
          sizeBytes: manifest?.totalSize || null,
          durationMs: Date.now() - startedAt,
        });
        return { id, manifest, uploaded: 0, errors: [] };
      }
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      this.healthRegistry?.recordAttempt("tier3", false, {
        error: err.message,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  // ─── Cloud Pull ────────────────────────────────────────────────────────────

  /**
   * List backup packages available on a cloud provider.
   * @param {string} provider  "onedrive" | "gdrive"
   */
  async listCloudBackups(provider) {
    const adapter = this._getProviderAdapter(provider);
    if (!adapter?.isConnected()) {
      throw new Error(`${provider}: not connected`);
    }
    return adapter.listBackups();
  }

  /**
   * Pull (download) a specific backup from cloud to local.
   * @param {string} provider
   * @param {string} remoteId  remote folder/file ID
   * @param {string} remoteName  folder name (e.g. "inverter-backup-...")
   */
  async pullFromCloud(provider, remoteId, remoteName) {
    const adapter = this._getProviderAdapter(provider);
    if (!adapter?.isConnected()) {
      throw new Error(`${provider}: not connected`);
    }

    this._setProgress({
      status: "pulling",
      pct: 10,
      message: `Pulling backup from ${provider}…`,
      provider,
      startedAt: Date.now(),
      error: null,
    });

    const dir = path.join(this.backupDir, remoteName);
    fs.mkdirSync(dir, { recursive: true });

    try {
      let fileItems = [];
      if (provider === "onedrive") {
        const accessToken = await adapter.getAccessToken();
        const walkOneDrive = async (folderId, relBase = "") => {
          const r = await fetch(
            `https://graph.microsoft.com/v1.0/me/drive/items/${folderId}/children`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            },
          );
          if (!r.ok) throw new Error(`OneDrive folder list failed: ${r.status}`);
          const { value } = await r.json();
          const entries = Array.isArray(value) ? value : [];
          for (const entry of entries) {
            const name = String(entry?.name || "").trim();
            if (!name) continue;
            if (entry.folder) {
              await walkOneDrive(entry.id, `${relBase}${name}/`);
            } else {
              fileItems.push({ id: entry.id, name: `${relBase}${name}` });
            }
          }
        };
        await walkOneDrive(remoteId, "");
      } else if (provider === "s3") {
        const remoteFiles = await adapter.listBackupFiles(remoteId);
        const manifestItem = remoteFiles.find((item) => String(item?.name || "") === "manifest.json");
        if (!manifestItem) {
          throw new Error("S3 backup manifest not found");
        }
        const manifestBuffer = await adapter.downloadBuffer(manifestItem.id);
        const manifestPath = path.join(dir, "manifest.json");
        fs.writeFileSync(manifestPath, manifestBuffer);
        const remoteManifest = safeReadJson(manifestPath);
        const s3CloudMeta =
          remoteManifest &&
          remoteManifest.cloud &&
          typeof remoteManifest.cloud.s3 === "object"
            ? remoteManifest.cloud.s3
            : null;
        const s3Files =
          s3CloudMeta && s3CloudMeta.files && typeof s3CloudMeta.files === "object"
            ? s3CloudMeta.files
            : null;
        if (s3CloudMeta?.layout === S3_DEDUPE_LAYOUT && s3Files) {
          const dedupedEntries = Object.entries(s3Files);
          const totalBytes = dedupedEntries.reduce(
            (sum, [, meta]) => sum + Number(meta?.size || 0),
            0,
          );
          let restoredBytes = 0;
          for (const [fname, meta] of dedupedEntries) {
            const localPath = path.join(dir, ...String(fname || "").split("/").filter(Boolean));
            await this._downloadS3ChunkedFile(adapter, localPath, meta, (_chunkMeta, chunkBytes) => {
              restoredBytes += Number(chunkBytes || 0);
              const ratio = totalBytes > 0 ? restoredBytes / totalBytes : 1;
              this._setProgress({
                pct: Math.min(92, 10 + Math.round(ratio * 80)),
                message: `Downloading ${fname}…`,
              });
            });
          }
          fileItems = [];
        } else {
          fileItems = remoteFiles.filter((item) => String(item?.name || "") !== "manifest.json");
        }
      } else {
        const r = await fetch(
          `https://www.googleapis.com/drive/v3/files/${remoteId}?fields=id,name,mimeType`,
          {
            headers: {
              Authorization: `Bearer ${await adapter.getAccessToken()}`,
            },
          },
        );
        const accessToken = await adapter.getAccessToken();
        if (!r.ok) throw new Error(`Google Drive folder check failed: ${r.status}`);
        const rootInfo = await r.json().catch(() => ({}));
        const FOLDER_MIME = "application/vnd.google-apps.folder";
        if (String(rootInfo?.mimeType || "") !== FOLDER_MIME) {
          throw new Error("Selected Google Drive backup item is not a folder");
        }
        const walkGDrive = async (folderId, relBase = "") => {
          const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
          const resp = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,size,mimeType)`,
            { headers: { Authorization: `Bearer ${accessToken}` } },
          );
          if (!resp.ok) throw new Error(`Google Drive folder list failed: ${resp.status}`);
          const { files } = await resp.json();
          const entries = Array.isArray(files) ? files : [];
          for (const entry of entries) {
            const name = String(entry?.name || "").trim();
            if (!name) continue;
            if (String(entry?.mimeType || "") === FOLDER_MIME) {
              await walkGDrive(entry.id, `${relBase}${name}/`);
            } else {
              fileItems.push({ id: entry.id, name: `${relBase}${name}` });
            }
          }
        };
        await walkGDrive(remoteId, "");
      }

      for (let i = 0; i < fileItems.length; i++) {
        const f = fileItems[i];
        const localPath = path.join(dir, ...String(f.name || "").split("/").filter(Boolean));
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        this._setProgress({
          pct: 10 + Math.round(((i + 1) / fileItems.length) * 80),
          message: `Downloading ${f.name}…`,
        });
        await adapter.downloadFile(f.id, localPath);
      }

      // Verify manifest + checksums.
      const manifestPath = path.join(dir, "manifest.json");
      if (!fs.existsSync(manifestPath)) {
        throw new Error("Downloaded backup is missing manifest.json");
      }
      const manifest = safeReadJson(manifestPath);
      const ok = this._verifyChecksums(dir, manifest);

      this._addHistoryEntry({
        id: remoteName,
        createdAt: manifest?.createdAt || new Date().toISOString(),
        scope: manifest?.scope || [],
        tag: manifest?.tag || "cloud-pull",
        totalSize: manifest?.totalSize || 0,
        status: ok ? "pulled" : "pulled-unverified",
        cloud: { [provider]: { pulledAt: new Date().toISOString() } },
        dir,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: ok
          ? `Pull complete. Checksum verified.`
          : `Pull complete. WARNING: checksum mismatch.`,
        finishedAt: Date.now(),
      });

      console.log(`[CloudBackup] Pulled ${remoteName} from ${provider}`);
      return { id: remoteName, dir, verified: ok, manifest };
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      throw err;
    }
  }

  // ─── Restore ──────────────────────────────────────────────────────────────

  /**
   * Restore a backup to the active app data.
   * Before restore, auto-creates a safety local backup for rollback.
   * @param {string} backupId  ID of local backup package to restore
   * @param {object} opts
   * @param {boolean} [opts.skipSafetyBackup=false]  Skip pre-restore safety backup
   * @param {string[]} [opts.scopeFilter]   v2.8.14: optional whitelist of scope names to actually
   *                                         restore. When present, the restore intersects this
   *                                         set with manifest.scope. Used by the bootstrap
   *                                         restore wizard so the operator can opt OUT of
   *                                         license/auth/logs etc. on a fresh install.
   */
  async restoreBackup(backupId, opts = {}) {
    // T2.2 fix: serialise via mutex.  The inner body may call
    // this.createLocalBackup() for the pre-restore safety snapshot — that
    // call runs within the already-held lock (createLocalBackup does NOT
    // re-enter _withBackupMutex) so there is no deadlock.
    return this._withBackupMutex("restoreBackup", () => this._restoreBackupLocked(backupId, opts));
  }

  /**
   * Helper: returns true if `scope` is allowed by the operator's filter.
   * No filter = allow everything that's in the manifest.
   */
  _scopeAllowed(scope, scopeFilter) {
    if (!scopeFilter) return true;
    if (!Array.isArray(scopeFilter)) return true;
    if (scopeFilter.length === 0) return false; // explicit empty = nothing
    return scopeFilter.includes(scope);
  }

  async _restoreBackupLocked(backupId, opts = {}) {
    if (
      this.progress.status !== "idle" &&
      this.progress.status !== "done" &&
      this.progress.status !== "error"
    ) {
      throw new Error("A backup/restore operation is already in progress");
    }

    const dir =
      this.history.find((h) => h.id === backupId)?.dir ||
      path.join(this.backupDir, backupId);
    if (!fs.existsSync(dir)) {
      throw new Error(`Backup package not found locally: ${backupId}`);
    }

    const manifest = safeReadJson(path.join(dir, "manifest.json"));
    if (!manifest) throw new Error("Backup manifest missing or corrupted");

    this._setProgress({
      status: "restoring",
      pct: 5,
      message: "Verifying backup integrity...",
      startedAt: Date.now(),
      error: null,
      finishedAt: null,
    });

    // v2.8.14 R5: track the pre-restore safety backup id so we can roll back
    // automatically if any later step throws.
    let safetyBackupId = null;

    try {
      this._checkCompatibility(manifest);

      const checksumOk = this._verifyChecksums(dir, manifest);
      if (!checksumOk) {
        throw new Error(
          "Backup integrity check failed (checksum mismatch). Refusing to restore.",
        );
      }

      // v2.8.14: probe writability of every restore destination BEFORE we
      // create the safety backup. If a target is read-only (Windows ACL on
      // ProgramData not extended to Users:M, USB mounted read-only, etc.) we
      // want a single clear error up-front rather than a half-finished restore
      // that triggers auto-rollback into the same broken directory.
      // The probe respects the scope filter (no point probing license dir if
      // the operator unchecked the license scope).
      this._assertRestoreDestinationsWritable(manifest, opts.scopeFilter);

      if (!opts.skipSafetyBackup) {
        this._setProgress({ pct: 15, message: "Creating safety backup before restore..." });
        try {
          const safety = await this.createLocalBackup({
            scope: ["database", "config"],
            tag: "pre-restore-safety",
          });
          safetyBackupId = safety?.id || null;
        } catch (err) {
          // v2.8.14 R5: refuse to proceed without a safety backup. If the disk
          // is too full to copy adsi.db, the partial-restore that follows
          // would leave the operator with no rollback option.
          throw new Error(
            `Safety backup failed; refusing to restore without a rollback option (${err.message})`,
          );
        }
      }

      if (manifest.scope?.includes("database") && this._scopeAllowed("database", opts.scopeFilter)) {
        const srcDb = path.join(dir, "adsi.db");
        if (fs.existsSync(srcDb)) {
          this._setProgress({ pct: 40, message: "Restoring database..." });
          const destDb = path.join(this.dataDir, "adsi.db");

          let pollerWasRunning = false;
          try {
            if (this.poller?.isRunning?.()) {
              this.poller.stop();
              pollerWasRunning = true;
            }
          } catch {
            // ignore
          }

          try {
            try {
              // v2.8.14 C-1 fix: SQLite leaves stale -wal / -shm files on disk
              // when the previous DB was opened in WAL mode. fs.copyFileSync
              // overwrites adsi.db only; on next open SQLite would replay the
              // old WAL against the freshly-copied file and corrupt it. Mirror
              // the cleanup that startup auto-restore already does in db.js.
              for (const suffix of ["-wal", "-shm"]) {
                try { fs.unlinkSync(`${destDb}${suffix}`); } catch (_) { /* not present */ }
              }
              fs.copyFileSync(srcDb, destDb);
            } catch (copyErr) {
              if (!this.db?.exec || !this.db?.prepare || !this.db?.transaction) {
                throw copyErr;
              }
              this._setProgress({ pct: 45, message: "Database file copy failed; applying live restore..." });
              try {
                this._restoreDbViaAttach(srcDb);
              } catch (liveErr) {
                const copyMsg = String(copyErr?.message || copyErr || "copy failed");
                const liveMsg = String(liveErr?.message || liveErr || "live restore failed");
                throw new Error(`Database restore failed: copy step error (${copyMsg}); live-restore error (${liveMsg})`);
              }
            }
            console.log("[CloudBackup] Database restored from:", srcDb);
          } finally {
            if (pollerWasRunning) {
              // T2.11 fix (Phase 2, 2026-04-14): explicit null-check before
              // calling .start().  If this.poller was torn down mid-restore
              // (early-boot race) the implicit TypeError is still caught but
              // leaves the error unclear in logs; be explicit.
              try {
                if (this.poller && typeof this.poller.start === "function") {
                  this.poller.start();
                } else {
                  console.warn("[CloudBackup] poller unavailable after restore; server restart may be required.");
                }
              } catch {
                // ignore restart errors; server restart may be needed
              }
            }
          }
        }
        if (this.programDataDir) {
          const srcForecastDir = path.join(dir, "forecast");
          const srcHistoryDir = path.join(dir, "history");
          const srcWeatherDir = path.join(dir, "weather");
          if (fs.existsSync(srcForecastDir)) {
            this._setProgress({ pct: 58, message: "Restoring forecast artifacts..." });
            const destForecastDir = path.join(this.programDataDir, "forecast");
            fs.rmSync(destForecastDir, { recursive: true, force: true });
            copyDirRecursive(srcForecastDir, destForecastDir);
          }
          if (fs.existsSync(srcHistoryDir)) {
            const destHistoryDir = path.join(this.programDataDir, "history");
            fs.rmSync(destHistoryDir, { recursive: true, force: true });
            copyDirRecursive(srcHistoryDir, destHistoryDir);
          }
          if (fs.existsSync(srcWeatherDir)) {
            const destWeatherDir = path.join(this.programDataDir, "weather");
            fs.rmSync(destWeatherDir, { recursive: true, force: true });
            copyDirRecursive(srcWeatherDir, destWeatherDir);
          }
        }
      }

      if (manifest.scope?.includes("config") && this._scopeAllowed("config", opts.scopeFilter)) {
        this._setProgress({ pct: 70, message: "Restoring config files..." });

        const srcIp = path.join(dir, "ipconfig.json");
        if (fs.existsSync(srcIp) && this.ipConfigPath) {
          fs.copyFileSync(srcIp, this.ipConfigPath);
          console.log("[CloudBackup] IP config restored.");
        }

        const srcSettings = path.join(dir, "settings.json");
        if (fs.existsSync(srcSettings)) {
          try {
            const settingsData = safeReadJson(srcSettings);
            if (settingsData && typeof settingsData === "object") {
              const sensitive = ["remoteApiToken", "solcastApiKey", "cloudBackupSettings"];
              for (const [k, v] of Object.entries(settingsData)) {
                if (!sensitive.includes(k)) {
                  this.setSetting(k, v);
                }
              }
              console.log("[CloudBackup] Settings restored.");
            }
          } catch (err) {
            console.warn("[CloudBackup] Settings restore failed:", err.message);
          }
        }
      }

      if (manifest.scope?.includes("logs") && this._scopeAllowed("logs", opts.scopeFilter)) {
        this._setProgress({ pct: 82, message: "Restoring logs..." });
        const srcLogsDir = path.join(dir, "logs");
        if (fs.existsSync(srcLogsDir)) {
          const dataLogsDir = path.join(this.dataDir, "logs");
          fs.mkdirSync(dataLogsDir, { recursive: true });
          // v2.8.14 path-fix: route logs to their canonical destinations.
          // forecast_dayahead.log → programDataDir/logs (handled below).
          // recovery.log         → programDataDir/logs (electron writes there).
          // everything else      → dataDir/logs (server-side rolling logs).
          const SPECIAL_PROGRAMDATA_LOGS = new Set(["forecast_dayahead.log", "recovery.log"]);
          for (const entry of fs.readdirSync(srcLogsDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            if (SPECIAL_PROGRAMDATA_LOGS.has(entry.name)) continue;
            const src = path.join(srcLogsDir, entry.name);
            const dst = path.join(dataLogsDir, entry.name);
            fs.copyFileSync(src, dst);
          }
          if (this.programDataDir) {
            const programDataLogsDir = path.join(this.programDataDir, "logs");
            fs.mkdirSync(programDataLogsDir, { recursive: true });
            for (const fname of SPECIAL_PROGRAMDATA_LOGS) {
              const src = path.join(srcLogsDir, fname);
              if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(programDataLogsDir, fname));
              }
            }
          }
        }
      }

      this._addHistoryEntry({
        id: `restore-${Date.now()}`,
        createdAt: new Date().toISOString(),
        scope: manifest.scope,
        tag: `restore-from-${backupId}`,
        totalSize: 0,
        status: "restored",
        cloud: {},
        dir: null,
        restoredFrom: backupId,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: "Restore complete. Please restart the app to apply changes.",
        finishedAt: Date.now(),
      });

      console.log("[CloudBackup] Restore complete from:", backupId);
      this.healthRegistry?.recordAttempt("portableManual", true, {
        destination: `restore:${backupId}`,
      });
      return { ok: true, manifest };
    } catch (err) {
      // v2.8.14 R5: auto-rollback on partial-restore failure.
      // Three outcomes possible at this point:
      //   1. No safety backup was taken (skipSafetyBackup=true, or restore
      //      failed before line 15) — nothing to roll back to. Surface the
      //      error and let the caller restart the app.
      //   2. Safety backup exists — attempt a rollback restore against it.
      //      If rollback succeeds, the operator sees an amber "rolled back"
      //      message and the live DB is back to its pre-restore state.
      //   3. Both restore AND rollback fail — emit a CRITICAL state so the
      //      UI tells the operator to restart and verify data manually.
      const restoreErrMsg = String(err?.message || err);

      if (!safetyBackupId) {
        this._setProgress({
          status: "error",
          pct: 0,
          message: restoreErrMsg,
          error: restoreErrMsg,
          finishedAt: Date.now(),
        });
        this.healthRegistry?.recordAttempt("portableManual", false, {
          error: `restore failed (no rollback): ${restoreErrMsg}`,
        });
        throw err;
      }

      console.error(
        "[CloudBackup] Restore failed mid-flight; attempting auto-rollback to safety backup:",
        safetyBackupId,
      );
      // Reset progress to "idle" first so the recursive _restoreBackupLocked
      // entry guard doesn't reject the rollback as "already in progress".
      // Mutex is still held by the outer _withBackupMutex caller, so no real
      // concurrent operation can sneak in here.
      this._setProgress({
        status: "idle",
        pct: 92,
        message: "Restore failed. Rolling back to pre-restore safety backup...",
      });

      try {
        // Re-enter the locked restore body for the safety package. We pass
        // skipSafetyBackup=true to prevent recursion (a rollback doesn't need
        // its own pre-rollback safety net — that net IS the safety backup).
        await this._restoreBackupLocked(safetyBackupId, { skipSafetyBackup: true });

        const rolledBackMsg =
          `Restore failed and was rolled back to the previous state. (${restoreErrMsg})`;
        // Intentionally set status="done" with a non-null error: from the
        // operation's standpoint the rollback completed cleanly (the system is
        // back in a known-good state), but we preserve the original error so
        // the UI can display "Restore failed → rolled back" with the cause.
        // Frontends that treat status==="done" as plain success will still
        // surface this correctly because the message text describes the
        // rollback explicitly.
        this._setProgress({
          status: "done",
          pct: 100,
          message: rolledBackMsg,
          finishedAt: Date.now(),
          error: restoreErrMsg,
        });
        console.warn("[CloudBackup] Auto-rollback succeeded.");
        this.healthRegistry?.recordAttempt("portableManual", false, {
          error: `restore failed; rolled back to ${safetyBackupId}: ${restoreErrMsg}`,
        });
        const rollbackErr = new Error(rolledBackMsg);
        rollbackErr.rolledBack = true;
        rollbackErr.cause = err;
        throw rollbackErr;
      } catch (rollbackErr) {
        if (rollbackErr?.rolledBack) {
          // Re-throw the "rolled back" success-failure path unchanged.
          throw rollbackErr;
        }
        const rollbackMsg = String(rollbackErr?.message || rollbackErr);
        const catastrophicMsg =
          `CRITICAL: Restore failed AND auto-rollback failed. ` +
          `Database may be in an inconsistent state. Restart the app and verify data, ` +
          `or contact support. (Restore: ${restoreErrMsg}; Rollback: ${rollbackMsg})`;
        console.error("[CloudBackup]", catastrophicMsg);
        this._setProgress({
          status: "error",
          pct: 0,
          message: catastrophicMsg,
          error: catastrophicMsg,
          finishedAt: Date.now(),
        });
        this.healthRegistry?.recordAttempt("portableManual", false, {
          error: catastrophicMsg,
        });
        const fatal = new Error(catastrophicMsg);
        fatal.catastrophic = true;
        fatal.requiresManualIntervention = true;
        throw fatal;
      }
    }
  }

  _quoteIdent(name) {
    return `"${String(name || "").replace(/"/g, '""')}"`;
  }

  _restoreDbViaAttach(srcDbPath) {
    if (!this.db?.exec || !this.db?.prepare || !this.db?.transaction) {
      throw new Error("Live database restore is unavailable (db handle missing).");
    }
    const src = String(srcDbPath || "").trim();
    if (!src || !fs.existsSync(src)) {
      throw new Error(`Restore source DB not found: ${src}`);
    }

    const alias = "restore_src";
    const escapedPath = src.replace(/'/g, "''");
    const detach = () => {
      try { this.db.exec(`DETACH DATABASE ${alias}`); } catch (_) {}
    };

    detach();
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec(`ATTACH DATABASE '${escapedPath}' AS ${alias}`);

      const dstRows = this.db
        .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all();
      const srcRows = this.db
        .prepare(`SELECT name FROM ${alias}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all();
      const srcTableSet = new Set(srcRows.map((r) => String(r?.name || "")));

      const tx = this.db.transaction(() => {
        for (const row of dstRows) {
          const tableName = String(row?.name || "");
          if (!tableName || !srcTableSet.has(tableName)) continue;

          const qTable = this._quoteIdent(tableName);
          const dstCols = this.db
            .prepare(`PRAGMA main.table_info(${qTable})`)
            .all()
            .map((c) => String(c?.name || ""));
          const srcCols = new Set(
            this.db
              .prepare(`PRAGMA ${alias}.table_info(${qTable})`)
              .all()
              .map((c) => String(c?.name || "")),
          );
          const cols = dstCols.filter((c) => c && srcCols.has(c));

          this.db.exec(`DELETE FROM ${qTable}`);
          if (!cols.length) continue;

          const qCols = cols.map((c) => this._quoteIdent(c)).join(", ");
          this.db.exec(`INSERT INTO ${qTable} (${qCols}) SELECT ${qCols} FROM ${alias}.${qTable}`);
        }

        const hasDstSeq = !!this.db
          .prepare("SELECT 1 AS ok FROM main.sqlite_master WHERE type='table' AND name='sqlite_sequence' LIMIT 1")
          .get();
        const hasSrcSeq = !!this.db
          .prepare(`SELECT 1 AS ok FROM ${alias}.sqlite_master WHERE type='table' AND name='sqlite_sequence' LIMIT 1`)
          .get();
        if (hasDstSeq && hasSrcSeq) {
          this.db.exec("DELETE FROM main.sqlite_sequence");
          this.db.exec(`INSERT INTO main.sqlite_sequence(name, seq) SELECT name, seq FROM ${alias}.sqlite_sequence`);
        }
      });
      tx();
    } finally {
      detach();
      try { this.db.pragma("foreign_keys = ON"); } catch (_) {}
    }
  }

  // Verification
  _verifyChecksums(dir, manifest) {
    if (!manifest?.checksums) return false;
    for (const [fname, expected] of Object.entries(manifest.checksums)) {
      if (fname === "manifest.json") continue; // self-referential, skip
      const fpath = path.join(dir, ...fname.split("/"));
      try {
        if (!fs.existsSync(fpath)) return false;
        const actual = sha256File(fpath);
        if (actual !== expected) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  _checkCompatibility(manifest) {
    // BR-Mi3 — package-layout gate. Older backups predate the field (treated as
    // format 1). A newer-format package cannot be safely read by this build.
    const fmt = Number(manifest.backupFormatVersion || 1);
    if (Number.isFinite(fmt) && fmt > BACKUP_FORMAT_VERSION) {
      throw new Error(
        `Backup package format (v${fmt}) is newer than this app supports ` +
          `(v${BACKUP_FORMAT_VERSION}). Update the app before restoring.`,
      );
    }
    const schema = String(manifest.schemaVersion || "1");
    const currentSchema = DB_SCHEMA_VERSION;
    if (Number(schema) > Number(currentSchema)) {
      throw new Error(
        `Backup schema version (${schema}) is newer than this app (${currentSchema}). ` +
          `Update the app before restoring.`,
      );
    }
    const backupAppVersion = String(manifest.appVersion || "0.0.0");
    if (semverCompare(backupAppVersion, APP_VERSION) > 0) {
      throw new Error(
        `Backup app version (${backupAppVersion}) is newer than this app (${APP_VERSION}). ` +
          `Update the app before restoring.`,
      );
    }
  }

  // ─── Scheduling ───────────────────────────────────────────────────────────

  _applySchedule(schedule, enabled) {
    if (this._cronJob) {
      this._cronJob.stop();
      this._cronJob = null;
    }
    if (!enabled || schedule === "manual") return;

    // v2.8.14 — moved daily cloud backup from 03:00 to 21:00. 03:00 sat
    // inside the Windows Automatic Maintenance + Windows Update install
    // window, competing with OS activity on the gateway PC and adding
    // network I/O on top (cloud backup uploads the DB + manifest to
    // Supabase/Neon). 21:00 is between the 20:00 and 22:00 forecast
    // regen crons and leaves the 01:00–05:00 window clear for Windows.
    const cronExpr =
      schedule === "daily" ? "0 21 * * *" : // 21:00 local — off-hours, outside Windows Maintenance
      schedule === "every6h" ? "0 */6 * * *" : null;

    if (!cronExpr) return;

    this._cronJob = cron.schedule(cronExpr, async () => {
      if (this._isRemoteMode()) {
        console.log("[CloudBackup] Scheduled cloud backup skipped (remote mode).");
        return;
      }
      console.log("[CloudBackup] Scheduled backup triggered:", schedule);
      try {
        await this.backupNow({ tag: `scheduled-${schedule}` });
      } catch (err) {
        console.error("[CloudBackup] Scheduled backup failed:", err.message);
      }
    });
    console.log("[CloudBackup] Schedule active:", schedule, cronExpr);
  }

  applyInitialSchedule() {
    const s = this.getCloudSettings();
    this._applySchedule(s.schedule, s.enabled);
    // v2.8.14 R1: also start the scheduled .adsibak cron if configured.
    try {
      this._applyLocalBackupSchedule();
    } catch (err) {
      console.warn("[CloudBackup] local schedule init failed:", err.message);
    }
  }

  // ─── Local Backup Settings (R1) ──────────────────────────────────────────

  getLocalBackupDefaults() {
    const defaultDest = this.programDataDir
      ? path.join(this.programDataDir, "portable_backups")
      : path.join(this.dataDir, "portable_backups");
    return {
      schedule: "off",                  // off | daily | weekly
      destination: defaultDest,
      retention: 5,                     // keep last N; 0 = unlimited
    };
  }

  getLocalBackupSettings() {
    const defaults = this.getLocalBackupDefaults();
    const raw = this.getSetting("localBackupSettings", null);
    if (!raw) return defaults;
    try {
      const parsed = JSON.parse(raw);
      return {
        schedule: parsed?.schedule === "daily" || parsed?.schedule === "weekly" ? parsed.schedule : "off",
        destination: typeof parsed?.destination === "string" && parsed.destination.trim()
          ? parsed.destination.trim()
          : defaults.destination,
        retention: Number.isFinite(Number(parsed?.retention)) && Number(parsed.retention) >= 0
          ? Math.trunc(Number(parsed.retention))
          : defaults.retention,
      };
    } catch {
      return defaults;
    }
  }

  saveLocalBackupSettings(body) {
    const defaults = this.getLocalBackupDefaults();
    const next = {
      schedule: body?.schedule === "daily" || body?.schedule === "weekly" ? body.schedule : "off",
      destination: typeof body?.destination === "string" && body.destination.trim()
        ? body.destination.trim()
        : defaults.destination,
      retention: Number.isFinite(Number(body?.retention)) && Number(body.retention) >= 0
        ? Math.trunc(Number(body.retention))
        : defaults.retention,
    };
    this.setSetting("localBackupSettings", JSON.stringify(next));
    this._applyLocalBackupSchedule();
    return next;
  }

  _applyLocalBackupSchedule() {
    if (this._localCronJob) {
      this._localCronJob.stop();
      this._localCronJob = null;
    }
    const cfg = this.getLocalBackupSettings();
    this.healthRegistry?.setDestination("portableScheduled", cfg.destination);
    if (cfg.schedule === "off") {
      this.healthRegistry?.setNextScheduled("portableScheduled", null);
      console.log("[CloudBackup] Local schedule: off");
      return;
    }
    // v2.8.14 — moved from 02:30 to 20:30. The original 02:30 slot sat
    // inside the Windows Automatic Maintenance + Windows Update install
    // window (roughly 01:00–05:00 local), so a full .adsibak compression
    // + write was competing with Windows' own disk/update activity on
    // the gateway PC. That collision is a credible contributor to the
    // nightly "Error 1962 — no operating system found" failures the
    // operator has been reporting. 20:30 is after the 20:00 forecast
    // regen cron completes and well before the 22:00 forecast cron,
    // giving the backup a clean window with no other heavy I/O.
    const cronExpr = cfg.schedule === "daily" ? "30 20 * * *" : "30 20 * * 0";
    // Defense-in-depth: even though runScheduledPortableBackup serializes via
    // _withBackupMutex, also skip overlapping cron ticks explicitly so we don't
    // queue a runaway backlog if a single run takes longer than the interval.
    let _running = false;
    this._localCronJob = cron.schedule(cronExpr, async () => {
      if (this._isRemoteMode()) {
        console.log("[CloudBackup] Scheduled .adsibak skipped (remote mode).");
        return;
      }
      if (_running) {
        console.warn("[CloudBackup] Scheduled .adsibak skipped: previous run still active.");
        return;
      }
      _running = true;
      console.log("[CloudBackup] Scheduled .adsibak triggered:", cfg.schedule);
      try {
        await this.runScheduledPortableBackup(cfg.destination, cfg.retention);
      } catch (err) {
        console.error("[CloudBackup] Scheduled .adsibak failed:", err.message);
      } finally {
        _running = false;
      }
    });
    // Best-effort estimate of next run (cron module's internal task isn't
    // public API; compute coarsely).
    this._refreshLocalNextScheduled(cfg.schedule);
    console.log("[CloudBackup] Local schedule active:", cfg.schedule, cronExpr, "→", cfg.destination);
  }

  _refreshLocalNextScheduled(schedule) {
    const now = new Date();
    const next = new Date(now);
    // v2.8.14 — keep in sync with the cron expression in _applyLocalSchedule.
    next.setHours(20, 30, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    if (schedule === "weekly") {
      // Advance to next Sunday.
      const daysUntilSunday = (7 - next.getDay()) % 7;
      if (daysUntilSunday > 0) next.setDate(next.getDate() + daysUntilSunday);
    }
    this.healthRegistry?.setNextScheduled("portableScheduled", next.getTime());
  }

  /**
   * Run a scheduled portable backup to the configured destination directory.
   * Records outcome in healthRegistry. Errors are logged but never re-thrown
   * because this is invoked from cron and there's no caller to receive them.
   */
  async runScheduledPortableBackup(destDir, retention) {
    const startedAt = Date.now();
    if (!destDir || typeof destDir !== "string") {
      const msg = "Scheduled .adsibak destination is not configured";
      this.healthRegistry?.recordAttempt("portableScheduled", false, { error: msg });
      throw new Error(msg);
    }
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch (err) {
      const msg = `Destination unwritable: ${err.message}`;
      this.healthRegistry?.recordAttempt("portableScheduled", false, {
        error: msg,
        destination: destDir,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `inverter-backup-${stamp}.adsibak`;
    const destPath = path.join(destDir, fileName);

    try {
      const result = await this._withBackupMutex("scheduledPortable", () =>
        this.createPortableBackup(destPath));
      const sizeBytes = result?.archiveSize || (fs.existsSync(destPath) ? fs.statSync(destPath).size : null);
      this.healthRegistry?.recordAttempt("portableScheduled", true, {
        destination: destPath,
        sizeBytes,
        durationMs: Date.now() - startedAt,
      });

      // Prune older backups beyond retention.
      const keep = Number.isFinite(Number(retention)) && Number(retention) >= 0
        ? Math.trunc(Number(retention))
        : 5;
      if (keep > 0) {
        try {
          this._prunePortableBackupDirectory(destDir, keep);
        } catch (err) {
          console.warn("[CloudBackup] Portable prune failed:", err.message);
        }
      }

      // Recompute next-scheduled timestamp for the UI.
      const cfg = this.getLocalBackupSettings();
      if (cfg.schedule !== "off") this._refreshLocalNextScheduled(cfg.schedule);

      return { ok: true, destPath, sizeBytes };
    } catch (err) {
      this.healthRegistry?.recordAttempt("portableScheduled", false, {
        error: err.message,
        destination: destDir,
        durationMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  _prunePortableBackupDirectory(dir, keepCount) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".adsibak"))
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) {}
        return { name: e.name, path: full, mtime };
      })
      .sort((a, b) => {
        // Newest first by mtime; fall back to ISO-stamp filename when mtimes
        // tie (rapid successive writes on fast SSDs can produce identical
        // millisecond timestamps).
        const dt = b.mtime - a.mtime;
        if (dt !== 0) return dt;
        return b.name.localeCompare(a.name);
      });

    if (entries.length <= keepCount) return;
    for (const old of entries.slice(keepCount)) {
      try {
        fs.unlinkSync(old.path);
        console.log("[CloudBackup] Pruned old portable backup:", old.name);
      } catch (err) {
        console.warn(`[CloudBackup] Failed to prune ${old.name}: ${err.message}`);
      }
    }
  }

  /**
   * Best-effort row counts for restore-preview UX. Skipped on tables that
   * don't exist (older schema). Returns null on total failure.
   */
  _collectRowCounts() {
    if (!this.db?.prepare) return null;
    const tables = [
      "readings",
      "energy_5min",
      "alarms",
      "audit_log",
      "forecast_run_audit",
      "forecast_intraday_run_audit",
      "solcast_snapshots",
      "inverter_counter_state",
      "inverter_counter_baseline",
      "inverter_clock_sync_log",
    ];
    const out = {};
    for (const t of tables) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
        out[t] = Number(row?.n || 0);
      } catch {
        // Table missing — skip silently.
      }
    }
    return out;
  }

  // ─── Retry Queue ──────────────────────────────────────────────────────────

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._processRetryQueue();
    }, 5 * 60 * 1000); // retry after 5 minutes
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  async _processRetryQueue() {
    const MAX_ATTEMPTS = 5;
    const queue = [...this._retryQueue];
    this._retryQueue = [];

    for (const item of queue) {
      if (item.attempts >= MAX_ATTEMPTS) {
        console.warn(
          `[CloudBackup] Retry limit reached for ${item.backupId} → ${item.provider}`,
        );
        continue;
      }
      item.attempts++;
      try {
        await this.uploadToCloud(item.backupId, [item.provider]);
        console.log(
          `[CloudBackup] Retry ${item.attempts}: uploaded ${item.backupId} → ${item.provider}`,
        );
      } catch (err) {
        console.error(
          `[CloudBackup] Retry ${item.attempts} failed: ${err.message}`,
        );
        this._retryQueue.push(item);
      }
    }

    if (this._retryQueue.length > 0) {
      this._scheduleRetry();
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _resolveProviders(pref) {
    const connected = [];
    if (
      (pref === "auto" || pref === "onedrive" || pref === "both") &&
      this.onedrive?.isConnected()
    ) {
      connected.push("onedrive");
    }
    if (
      (pref === "auto" || pref === "gdrive" || pref === "both") &&
      this.gdrive?.isConnected()
    ) {
      connected.push("gdrive");
    }
    if (
      (pref === "auto" || pref === "s3" || pref === "both") &&
      this.s3?.isConnected()
    ) {
      connected.push("s3");
    }
    return connected;
  }

  getConnectedProviders() {
    return this.tokenStore.listConnected();
  }

  /** Delete a local backup package and remove from history. */
  deleteLocalBackup(backupId) {
    const idx = this.history.findIndex((h) => h.id === backupId);
    const dir =
      idx >= 0 ? this.history[idx]?.dir : path.join(this.backupDir, backupId);
    if (idx >= 0) this.history.splice(idx, 1);
    this._saveHistory();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return { ok: true };
  }

  // ─── Portable Backup (Full System) ────────────────────────────────────────

  /**
   * Create a full-system backup and export as a portable .adsibak file.
   * Includes: database, config, forecast, archive, license, auth.
   * @param {string} destPath  Destination file path (.adsibak)
   * @returns {Promise<{ok, path, manifest}>}
   */
  async createPortableBackup(destPath) {
    if (
      this.progress.status !== "idle" &&
      this.progress.status !== "done" &&
      this.progress.status !== "error"
    ) {
      throw new Error("A backup/restore operation is already in progress");
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    this._setProgress({
      status: "creating",
      pct: 2,
      message: "Creating full system backup…",
      startedAt: Date.now(),
      error: null,
      finishedAt: null,
    });

    const _portableStartedAt = Date.now();
    try {
      // Step 1: Create standard backup with database + config + logs
      this._setProgress({ pct: 5, message: "Backing up database and config…" });
      const { id, dir, manifest } = await this.createLocalBackup({
        scope: ["database", "config", "logs"],
        tag: "portable-full",
      });

      // Step 2: Copy additional directories into the package
      const root = getNewRoot();

      // Archive databases
      const archiveDir = this.archiveDir;
      if (fs.existsSync(archiveDir)) {
        this._setProgress({ pct: 50, message: "Backing up archive databases…" });
        const archiveDest = path.join(dir, "archive");
        copyDirRecursive(archiveDir, archiveDest);
        await this._recordFilesFromDir(archiveDest, "archive", manifest.checksums, manifest.files);
      }

      // Lifecycle directory
      const lifecycleDir = path.join(root, "lifecycle");
      if (fs.existsSync(lifecycleDir)) {
        this._setProgress({ pct: 55, message: "Backing up lifecycle state…" });
        const lifecycleDest = path.join(dir, "lifecycle");
        copyDirRecursive(lifecycleDir, lifecycleDest);
        await this._recordFilesFromDir(lifecycleDest, "lifecycle", manifest.checksums, manifest.files);
      }

      // Root JSON files
      this._setProgress({ pct: 58, message: "Backing up root configuration files…" });
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) {
          if (entry.name === "ipconfig.json" || entry.name === "settings.json" || entry.name === "manifest.json") continue;
          const srcPath = path.join(root, entry.name);
          const destPath = path.join(dir, entry.name);
          fs.copyFileSync(srcPath, destPath);
          manifest.checksums[entry.name] = sha256File(destPath);
          manifest.files.push({ name: entry.name, size: fs.statSync(destPath).size });
        }
      }

      // Auth tokens
      const authDir = path.join(root, "auth");
      if (fs.existsSync(authDir)) {
        this._setProgress({ pct: 62, message: "Backing up auth tokens…" });
        const authDest = path.join(dir, "auth");
        copyDirRecursive(authDir, authDest);
        await this._recordFilesFromDir(authDest, "auth", manifest.checksums, manifest.files);
      }

      // Update manifest with full scope
      manifest.scope = ["database", "config", "logs", "archive", "auth", "lifecycle", "root_json"];
      manifest.tag = "portable-full";
      manifest.totalSize = manifest.files.reduce((s, f) => s + f.size, 0);
      const manifestPath = path.join(dir, "manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      // Step 3: Zip the package then rename to .adsibak.
      // v2.8.14 hotfix: switched from `powershell Compress-Archive` to
      // Node's `archiver` (Zip64-capable). Rationale + 2 GiB cap incident
      // documented in audits/2026-04-22/local-backup-export-2gib-fix.md.
      this._setProgress({ pct: 70, message: "Compressing backup…" });
      const zipTmp = destPath.replace(/\.adsibak$/i, ".zip");

      await this._zipDirectory(dir, zipTmp, (processed, total) => {
        // Map archiver bytes-progress onto the 70-90% slice of the export
        // progress bar so the operator sees the long compression step move.
        const ratio = total > 0 ? Math.min(processed / total, 1) : 0;
        const pct = 70 + Math.round(ratio * 20);
        this._setProgress({
          pct,
          message: total > 0
            ? `Compressing backup… (${(processed / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB)`
            : "Compressing backup…",
        });
      });

      if (!fs.existsSync(zipTmp)) {
        throw new Error("Failed to create backup archive");
      }
      fs.renameSync(zipTmp, destPath);

      const archiveSize = fs.statSync(destPath).size;

      // Step 4: Clean up the temporary package directory
      this._setProgress({ pct: 90, message: "Cleaning up…" });
      this.deleteLocalBackup(id);

      this._addHistoryEntry({
        id: `portable-${Date.now()}`,
        createdAt: manifest.createdAt,
        scope: manifest.scope,
        tag: "portable-full",
        totalSize: archiveSize,
        status: "exported",
        cloud: {},
        dir: null,
        exportedTo: destPath,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: `Backup exported (${(archiveSize / 1048576).toFixed(1)} MB)`,
        finishedAt: Date.now(),
      });

      console.log(`[CloudBackup] Portable backup exported: ${destPath}`);
      this.healthRegistry?.recordAttempt("portableManual", true, {
        destination: destPath,
        sizeBytes: archiveSize,
        durationMs: Date.now() - _portableStartedAt,
      });
      return { ok: true, path: destPath, manifest, archiveSize };
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      this.healthRegistry?.recordAttempt("portableManual", false, {
        destination: destPath,
        error: err.message,
        durationMs: Date.now() - _portableStartedAt,
      });
      throw err;
    }
  }

  /**
   * Import a portable .adsibak file, validate it, and make it available for restore.
   * @param {string} srcPath  Path to the .adsibak file
   * @returns {Promise<{ok, id, manifest}>}
   */
  async importPortableBackup(srcPath) {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Backup file not found: ${srcPath}`);
    }

    if (
      this.progress.status !== "idle" &&
      this.progress.status !== "done" &&
      this.progress.status !== "error"
    ) {
      throw new Error("A backup/restore operation is already in progress");
    }

    this._setProgress({
      status: "creating",
      pct: 5,
      message: "Importing backup file…",
      startedAt: Date.now(),
      error: null,
      finishedAt: null,
    });

    try {
      // Step 1: Extract to a temporary directory
      const nowIso = new Date().toISOString().replace(/[:.]/g, "-");
      const id = `imported-backup-${nowIso}`;
      const dir = path.join(this.backupDir, id);
      fs.mkdirSync(dir, { recursive: true });

      this._setProgress({ pct: 20, message: "Extracting backup archive…" });

      // v2.8.14 hotfix: switched from `powershell Expand-Archive` to Node's
      // The contained yauzl extractor is Zip64-capable and reads the zip
      // directly so we no longer copy multi-gigabyte archives to a tmp
      // location first — saves an entire archive's worth of disk I/O.
      await this._extractZip(srcPath, dir);

      // Step 2: Read and validate manifest
      this._setProgress({ pct: 50, message: "Validating backup…" });
      const manifest = safeReadJson(path.join(dir, "manifest.json"));
      if (!manifest) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error("Invalid backup file: manifest.json not found or corrupted");
      }

      // Check compatibility
      this._checkCompatibility(manifest);

      // Step 3: Verify checksums
      this._setProgress({ pct: 60, message: "Verifying file integrity…" });
      const checksumOk = this._verifyChecksums(dir, manifest);
      if (!checksumOk) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new Error("Backup integrity check failed (checksum mismatch)");
      }

      // Step 4: Add to history
      this._setProgress({ pct: 85, message: "Registering backup…" });
      this._addHistoryEntry({
        id,
        createdAt: manifest.createdAt,
        scope: manifest.scope || ["database", "config"],
        tag: manifest.tag || "imported",
        totalSize: manifest.totalSize || 0,
        status: "imported",
        cloud: {},
        dir,
        importedFrom: srcPath,
      });

      this._setProgress({
        status: "done",
        pct: 100,
        message: "Backup imported and validated. Ready to restore.",
        finishedAt: Date.now(),
      });

      console.log(`[CloudBackup] Portable backup imported: ${id}`);
      return { ok: true, id, manifest };
    } catch (err) {
      this._setProgress({
        status: "error",
        pct: 0,
        message: err.message,
        error: err.message,
        finishedAt: Date.now(),
      });
      throw err;
    }
  }

  /**
   * Validate a portable .adsibak file without importing it.
   * Returns manifest info for user preview.
   * @param {string} srcPath  Path to the .adsibak file
   * @returns {Promise<{ok, manifest, fileCount, totalSize}>}
   */
  async validatePortableBackup(srcPath) {
    if (!fs.existsSync(srcPath)) {
      throw new Error(`Backup file not found: ${srcPath}`);
    }

    // Extract to temp dir for validation
    const tempDir = path.join(this.backupDir, `_validate-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // v2.8.14 hotfix: the extractor reads .adsibak directly (no tmp-zip copy
    // step needed), supports Zip64, and is async (no event-loop block).
    try {
      await this._extractZip(srcPath, tempDir);

      const manifest = safeReadJson(path.join(tempDir, "manifest.json"));
      if (!manifest) {
        throw new Error("Invalid backup: manifest.json not found");
      }

      this._checkCompatibility(manifest);
      const checksumOk = this._verifyChecksums(tempDir, manifest);

      return {
        ok: true,
        manifest: {
          appVersion: manifest.appVersion,
          schemaVersion: manifest.schemaVersion,
          createdAt: manifest.createdAt,
          scope: manifest.scope,
          tag: manifest.tag,
        },
        fileCount: Array.isArray(manifest.files) ? manifest.files.length : 0,
        totalSize: manifest.totalSize || 0,
        archiveSize: fs.statSync(srcPath).size,
        checksumOk,
        // v2.8.14 R3: surface row counts so the restore-preview modal can
        // tell the operator what's about to be overwritten. Optional —
        // older backups (v2.8.13 and earlier) won't have this key.
        rowCounts: manifest.rowCounts || null,
      };
    } finally {
      // No temp .zip to clean up with direct extraction — only the
      // extracted tempDir.
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Restore a portable backup including archive, license, and auth directories.
   * Extends standard restoreBackup with extra scope handling.
   * @param {string} backupId  ID of the imported backup package
   * @param {object} [opts]
   * @param {boolean} [opts.skipSafetyBackup]  Skip pre-restore safety backup
   * @param {string[]} [opts.scopeFilter]      v2.8.14: whitelist of scope names to restore.
   *                                            When present, intersect with manifest.scope.
   * @returns {Promise<{ok, manifest}>}
   */
  async restorePortableBackup(backupId, opts = {}) {
    // T2.2 fix: serialise portable restore too.  We call the private
    // `_restoreBackupLocked` directly (not the public `restoreBackup`
    // wrapper) so we hold the mutex for the entire portable-restore
    // workflow — standard restore PLUS forecast-scope fixups — rather
    // than releasing and re-acquiring between phases.
    return this._withBackupMutex("restorePortableBackup", () => this._restorePortableBackupLocked(backupId, opts));
  }

  async _restorePortableBackupLocked(backupId, opts = {}) {
    // First run the standard restore (handles database, config, logs).
    // Pass opts through so the scope filter applies to those scopes too.
    const result = await this._restoreBackupLocked(backupId, opts);
    const dir =
      this.history.find((h) => h.id === backupId)?.dir ||
      path.join(this.backupDir, backupId);

    if (!fs.existsSync(dir)) return result;

    const manifest = safeReadJson(path.join(dir, "manifest.json"));
    const scope = manifest?.scope || [];
    const root = getNewRoot();
    const allow = (s) => scope.includes(s) && this._scopeAllowed(s, opts.scopeFilter);

    // Restore archive databases
    if (allow("archive")) {
      const srcArchive = path.join(dir, "archive");
      if (fs.existsSync(srcArchive)) {
        const destArchive = this.archiveDir;
        fs.mkdirSync(destArchive, { recursive: true });
        copyDirRecursive(srcArchive, destArchive);
        console.log("[CloudBackup] Archive databases restored.");
      }
    }

    // Restore lifecycle state
    if (allow("lifecycle")) {
      const srcLifecycle = path.join(dir, "lifecycle");
      if (fs.existsSync(srcLifecycle)) {
        const destLifecycle = path.join(root, "lifecycle");
        fs.mkdirSync(destLifecycle, { recursive: true });
        copyDirRecursive(srcLifecycle, destLifecycle);
        console.log("[CloudBackup] Lifecycle state restored.");
      }
    }

    // Restore root JSONs
    if (allow("root_json")) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl"))) {
          if (entry.name === "ipconfig.json" || entry.name === "settings.json" || entry.name === "manifest.json") continue;
          const srcPath = path.join(dir, entry.name);
          const destPath = path.join(root, entry.name);
          fs.copyFileSync(srcPath, destPath);
          console.log(`[CloudBackup] Restored root state file: ${entry.name}`);
        }
      }
    }

    // Restore auth tokens
    if (allow("auth")) {
      const srcAuth = path.join(dir, "auth");
      if (fs.existsSync(srcAuth)) {
        const destAuth = path.join(root, "auth");
        fs.mkdirSync(destAuth, { recursive: true });
        copyDirRecursive(srcAuth, destAuth);
        console.log("[CloudBackup] Auth tokens restored.");
      }
    }

    return result;
  }
}

module.exports = CloudBackupService;
