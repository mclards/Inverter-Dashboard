"use strict";
/**
 * bootstrapRestore.js — v2.8.14 Restore-at-License-Prompt wizard
 *
 * WHY: Operators reinstalling the dashboard on a new PC (after OS rebuild,
 * hardware migration, or first deploy from a saved .adsibak) currently have
 * no way to seed the fresh install with their existing data. The native
 * license prompt offers only "Start Trial / Upload License / Exit" — none
 * of which restore database, settings, archives, etc. They have to start
 * trial, log in, navigate to Settings → Local Backup, import the .adsibak,
 * confirm restore, and restart. That's brittle and error-prone.
 *
 * WHAT: This module adds a 4th option to ensureLicenseAtStartup —
 * "Restore from Backup..." — that:
 *   1. Opens a native file picker for a .adsibak
 *   2. Validates the file (manifest + checksums)
 *   3. Spawns a small modal BrowserWindow with a scope checklist
 *      (database, config, logs, archive, license, auth) — defaulting to
 *      everything checked
 *   4. Runs the restore in-process (NO embedded server is running yet)
 *   5. On success, schedules an app.relaunch() so the freshly restored DB,
 *      license, and settings are picked up cleanly
 *
 * IMPLEMENTATION NOTES:
 * - The embedded Express server is NOT running during the license prompt,
 *   so we cannot use any HTTP endpoints. CloudBackupService is constructed
 *   directly with stub dependencies (no live db handle, no poller, no cloud
 *   providers) — sufficient for portable .adsibak import + restore because
 *   restorePortableBackup uses fs.copyFileSync (no live DB handle needed).
 * - The wizard window communicates over IPC with handlers registered here.
 *   We register them lazily (inside runBootstrapRestoreFlow) and unregister
 *   them when the window closes, so they don't leak across runs.
 * - Restored license takes effect on next launch — we do app.relaunch() then
 *   app.exit(0) to force a clean reboot through the integrity gate, license
 *   loader, and storage migration in proper order.
 * - The IIFE that grants Users:M on %PROGRAMDATA%\InverterDashboard normally
 *   runs from server/index.js — but the server isn't loaded yet, so we
 *   replicate it here BEFORE constructing the service.
 *
 * SECURITY NOTES:
 * - All paths the wizard hands back to main are treated as untrusted: we
 *   verify file existence, extension, and absolute-path resolution before
 *   touching them.
 * - The IPC channel names are unique to this module to avoid collision with
 *   the main app's channels — they're only registered when the wizard is
 *   open.
 * - No remote-mode check is needed here: at this point the dashboard hasn't
 *   even loaded settings yet, so operationMode defaults to "gateway".
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");

// ─── Constants ────────────────────────────────────────────────────────────
const SCOPE_DEFINITIONS = [
  {
    key: "database",
    label: "Plant database (adsi.db, forecast, history, weather)",
    detail: "Energy readings, alarms, forecasts, weather snapshots — the bulk of plant data.",
    defaultChecked: true,
    critical: true, // strongly recommended for migration
  },
  {
    key: "config",
    label: "App settings & inverter IP topology",
    detail: "Inverter IPs, plant settings, theme, schedules. Excludes API keys/tokens.",
    defaultChecked: true,
    critical: true,
  },
  {
    key: "logs",
    label: "Diagnostic logs (recovery.log, forecast log, dashboard log)",
    detail: "Includes recovery.log so the integrity-gate history survives migration. Skip on a brand-new install only if disk space matters.",
    defaultChecked: false,
    critical: false,
  },
  {
    key: "archive",
    label: "Long-term archive databases",
    detail: "Historical roll-ups stored separately from the hot DB. Skip if disk space is limited.",
    defaultChecked: true,
    critical: false,
  },
  {
    key: "license",
    label: "License files (legacy reference only)",
    detail: "Hardware-bound — restored license will be re-validated against THIS machine's fingerprint.",
    defaultChecked: false,
    critical: false,
  },
  {
    key: "auth",
    label: "Cloud auth tokens (OneDrive / Drive / S3)",
    detail: "Encrypted with the source machine's key — usually need to re-authenticate after migration.",
    defaultChecked: false,
    critical: false,
  },
];

const IPC = {
  PICK_FILE: "bootstrap-restore:pick-file",
  VALIDATE: "bootstrap-restore:validate",
  RUN: "bootstrap-restore:run",
  CANCEL: "bootstrap-restore:cancel",
  GET_SCOPES: "bootstrap-restore:get-scopes",
  COMPLETE: "bootstrap-restore:complete",
};

const WIZARD_INVOKE_CHANNELS = [
  IPC.PICK_FILE, IPC.VALIDATE, IPC.RUN, IPC.CANCEL, IPC.GET_SCOPES,
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function getProgramDataRoot() {
  return process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE || "C:\\ProgramData";
}

function getProgramDataDir() {
  return path.join(getProgramDataRoot(), "InverterDashboard");
}

function getDataDir() {
  // Mirror server/db.js consolidated layout: %PROGRAMDATA%\InverterDashboard\db
  return path.join(getProgramDataDir(), "db");
}

function getIpConfigPath() {
  return path.join(getProgramDataDir(), "ipconfig.json");
}

function getBackupDir() {
  return path.join(getProgramDataDir(), "cloud_backups");
}

function getBackupHistoryFile() {
  return path.join(getProgramDataDir(), "backup_history.json");
}

/**
 * Replicate server/index.js's ensureProgramDataRootWritable() IIFE.
 * The server IIFE only runs when server/index.js is required — bootstrap
 * restore happens BEFORE the server starts, so on a fresh non-admin install
 * the restore would otherwise fail mid-flight with EPERM. Idempotent: the
 * probe-write returns immediately if the directory is already writable.
 */
function ensureProgramDataRootWritable() {
  if (process.platform !== "win32") return { ok: true, action: "noop-platform" };
  const root = getProgramDataDir();
  try {
    fs.mkdirSync(root, { recursive: true });
    const probe = path.join(root, ".bootstrap-restore-probe");
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return { ok: true, action: "already-writable" };
  } catch (probeErr) {
    try {
      const r = spawnSync(
        "icacls",
        [root, "/grant", "Users:(OI)(CI)M", "/T", "/Q"],
        { windowsHide: true, timeout: 15000 },
      );
      if (r.error) throw r.error;
      if (r.status !== 0) {
        return {
          ok: false,
          action: "icacls-failed",
          error: `icacls exited ${r.status}: ${(r.stderr || "").toString().trim()}`,
        };
      }
      return { ok: true, action: "icacls-granted" };
    } catch (err) {
      return {
        ok: false,
        action: "icacls-error",
        error: `${err.message} (initial probe: ${probeErr.message})`,
      };
    }
  }
}

/**
 * Validate that an external user-supplied path actually points to an
 * existing readable .adsibak file.  Reject anything else — the wizard
 * should never hand us a directory or a path traversal artifact.
 */
function assertValidAdsibakPath(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("No backup file selected.");
  }
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) {
    throw new Error(`Backup file not found: ${abs}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) {
    throw new Error("Selected path is not a file.");
  }
  if (!/\.adsibak$/i.test(abs)) {
    throw new Error("Selected file is not a .adsibak archive.");
  }
  return abs;
}

/**
 * Build a minimal CloudBackupService instance suitable for bootstrap-time
 * restore. The embedded server is NOT running, so we lack a real db handle,
 * poller, or cloud providers. That's fine — the portable restore path uses
 * fs.copyFileSync and does not require any of them.
 */
function buildBootstrapBackupService() {
  // eslint-disable-next-line global-require
  const CloudBackupService = require("../server/cloudBackup");

  const settingsStore = new Map();
  const programDataDir = getProgramDataDir();
  const dataDir = getDataDir();
  const ipConfigPath = getIpConfigPath();
  const backupDir = getBackupDir();
  const historyFile = getBackupHistoryFile();

  // Ensure target directories exist before the service initializes.
  for (const d of [programDataDir, dataDir, backupDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* best-effort */ }
  }

  return new CloudBackupService({
    dataDir,
    db: null, // no live DB during bootstrap — restore uses fs.copyFileSync
    getSetting: (k, fb = null) => (settingsStore.has(k) ? settingsStore.get(k) : fb),
    setSetting: (k, v) => { settingsStore.set(k, v); },
    tokenStore: { isConnected: () => false, listConnected: () => [] },
    onedrive: null,
    gdrive: null,
    s3: null,
    poller: { isRunning: () => false, stop: () => {}, start: () => {} },
    ipConfigPath,
    programDataDir,
    backupDir,
    historyFile,
  });
}

// ─── Wizard window state ──────────────────────────────────────────────────

let wizardWin = null;
let activeBootstrapPromise = null;

// Tracks an in-flight restore so close/cancel can be intercepted.  Set to
// true the moment IPC.RUN is invoked, cleared in the finally block.
// NOTE: this is module-scoped because the close-event handler captured
// during runBootstrapRestoreFlow needs to read it.
let restoreInFlight = false;

function unregisterIpcHandlers() {
  for (const ch of WIZARD_INVOKE_CHANNELS) {
    try { ipcMain.removeHandler(ch); } catch (_) { /* not registered */ }
  }
}

/**
 * Run the full bootstrap-restore flow.  Resolves with one of:
 *   { ok: true, canceled: true }       — user closed the wizard without action
 *   { ok: true, restored: true,        — restore succeeded; caller should
 *     willRelaunch: true,                relaunch the app to pick up new DB
 *     scope: [...] }
 *   { ok: false, error: "<message>" }  — fatal error inside the wizard or
 *                                        restore (already shown to user)
 *
 * The caller (ensureLicenseAtStartup loop) decides what to do next.  On
 * success it triggers app.relaunch() + app.exit(0).
 */
async function runBootstrapRestoreFlow(parentWin) {
  if (activeBootstrapPromise) return activeBootstrapPromise;

  activeBootstrapPromise = (async () => {
    let resolveOuter;
    const completion = new Promise((resolve) => { resolveOuter = resolve; });
    let outerSettled = false;
    const settle = (value) => {
      if (outerSettled) return;
      outerSettled = true;
      resolveOuter(value);
    };

    // Track the current imported-package id so we can clean it up if the
    // restore step fails. Cleared after a successful restore.
    let importedPackageId = null;
    let importedPackageDir = null;

    // Tracks whether a successful restore has happened.  Used by the
    // close-event handler so that X-closing the wizard AFTER a successful
    // restore (without clicking Relaunch) is treated as restored — the DB
    // is already overwritten, so we MUST relaunch to pick it up.
    let restoreSucceeded = false;
    let lastRestoredScope = null;

    // ── IPC: get scopes ────────────────────────────────────────────────
    ipcMain.handle(IPC.GET_SCOPES, () => SCOPE_DEFINITIONS);

    // ── IPC: pick file ────────────────────────────────────────────────
    ipcMain.handle(IPC.PICK_FILE, async () => {
      const result = await dialog.showOpenDialog(wizardWin || parentWin || undefined, {
        title: "Select backup file (.adsibak)",
        filters: [
          { name: "ADSI Backup", extensions: ["adsibak"] },
          { name: "All Files", extensions: ["*"] },
        ],
        properties: ["openFile"],
      });
      if (result.canceled || !result.filePaths?.length) {
        return { ok: false, canceled: true };
      }
      try {
        const abs = assertValidAdsibakPath(result.filePaths[0]);
        const stat = fs.statSync(abs);
        return { ok: true, path: abs, size: stat.size };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // ── IPC: validate ─────────────────────────────────────────────────
    ipcMain.handle(IPC.VALIDATE, async (_evt, sourcePath) => {
      try {
        const abs = assertValidAdsibakPath(sourcePath);
        const svc = buildBootstrapBackupService();
        const info = await svc.validatePortableBackup(abs);
        return {
          ok: true,
          info: {
            appVersion: info.manifest?.appVersion || "unknown",
            schemaVersion: info.manifest?.schemaVersion || null,
            createdAt: info.manifest?.createdAt || null,
            scope: Array.isArray(info.manifest?.scope) ? info.manifest.scope : [],
            tag: info.manifest?.tag || null,
            fileCount: info.fileCount || 0,
            totalSize: info.totalSize || 0,
            archiveSize: info.archiveSize || 0,
            checksumOk: info.checksumOk !== false,
            rowCounts: info.rowCounts || null,
          },
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // ── IPC: run restore ──────────────────────────────────────────────
    ipcMain.handle(IPC.RUN, async (_evt, payload) => {
      if (restoreInFlight) {
        return { ok: false, error: "A restore is already in progress." };
      }
      restoreInFlight = true;
      let svc = null;
      try {
        const sourcePath = assertValidAdsibakPath(payload?.sourcePath);
        const requestedScopes = Array.isArray(payload?.scopeFilter)
          ? payload.scopeFilter
              .map((s) => String(s || "").trim().toLowerCase())
              .filter((s) => SCOPE_DEFINITIONS.some((def) => def.key === s))
          : null;

        if (requestedScopes && requestedScopes.length === 0) {
          throw new Error("Select at least one item to restore.");
        }

        // Fix #3: explicitly grant Users:M on %PROGRAMDATA%\InverterDashboard
        // BEFORE constructing the service. The IIFE in server/index.js does
        // this normally, but the server isn't loaded during bootstrap.
        const aclResult = ensureProgramDataRootWritable();
        if (!aclResult.ok) {
          throw new Error(
            "Cannot write to %PROGRAMDATA%\\InverterDashboard\\ — " +
            "restore would fail mid-flight. " +
            `Manual fix: open an elevated PowerShell and run:\n` +
            `  icacls "%PROGRAMDATA%\\InverterDashboard" /grant Users:(OI)(CI)M /T\n\n` +
            `(Underlying error: ${aclResult.error})`
          );
        }

        svc = buildBootstrapBackupService();

        // Step 1: import the .adsibak (extracts to backupDir, registers it)
        const imported = await svc.importPortableBackup(sourcePath);
        importedPackageId = imported.id;
        importedPackageDir = path.join(getBackupDir(), imported.id);

        // Step 2: portable restore with the user-selected scope filter
        const result = await svc.restorePortableBackup(imported.id, {
          // No safety backup makes sense pre-license: there's nothing to back
          // up because the install is fresh.  This also avoids an initial
          // pre-restore writability probe failure on an empty PROGRAMDATA.
          skipSafetyBackup: true,
          scopeFilter: requestedScopes,
        });

        // Imported package can stay — it's now part of normal history and
        // serves as the "last bootstrap restore" trail.
        importedPackageId = null;
        importedPackageDir = null;
        restoreSucceeded = true;
        lastRestoredScope = requestedScopes;

        return {
          ok: true,
          restored: true,
          scope: requestedScopes,
          manifest: {
            createdAt: result?.manifest?.createdAt,
            appVersion: result?.manifest?.appVersion,
          },
        };
      } catch (err) {
        // Fix #4: clean up the imported package directory on failure so
        // retries don't accumulate cruft. The history file is best-effort
        // — if it was modified by importPortableBackup, drop the entry.
        if (importedPackageId && importedPackageDir) {
          try {
            if (fs.existsSync(importedPackageDir)) {
              fs.rmSync(importedPackageDir, { recursive: true, force: true });
            }
            if (svc && Array.isArray(svc.history)) {
              const before = svc.history.length;
              svc.history = svc.history.filter((h) => h.id !== importedPackageId);
              if (svc.history.length !== before) svc._saveHistory();
            }
          } catch (cleanupErr) {
            console.warn(
              "[bootstrapRestore] Failed to clean up imported package after restore error:",
              cleanupErr.message,
            );
          }
        }
        return { ok: false, error: err.message || String(err) };
      } finally {
        restoreInFlight = false;
      }
    });

    // ── IPC: cancel ───────────────────────────────────────────────────
    ipcMain.handle(IPC.CANCEL, () => {
      // Fix #2: do NOT honour cancel during an in-flight restore.
      // The renderer disables the button too, but defense-in-depth.
      if (restoreInFlight) {
        return { ok: false, error: "Restore in progress; please wait." };
      }
      settle({ ok: true, canceled: true });
      // Window will close itself in response to the IPC reply.
      if (wizardWin && !wizardWin.isDestroyed()) {
        try { wizardWin.close(); } catch (_) { /* ignore */ }
      }
      return { ok: true };
    });

    // ── IPC: complete (renderer reports terminal state) ───────────────
    // Used ONLY for the success path: after the user clicks Relaunch on
    // step 5, the renderer calls complete({restored:true}) which lets us
    // resolve the outer promise → caller does app.relaunch().
    const onWizardComplete = (_evt, payload) => {
      if (payload?.restored) {
        settle({
          ok: true,
          restored: true,
          willRelaunch: true,
          scope: payload.scope || null,
        });
        if (wizardWin && !wizardWin.isDestroyed()) {
          try { wizardWin.close(); } catch (_) { /* ignore */ }
        }
      } else if (payload?.error) {
        settle({ ok: false, error: payload.error });
      } else if (payload?.canceled) {
        settle({ ok: true, canceled: true });
      }
    };
    ipcMain.on(IPC.COMPLETE, onWizardComplete);

    // ── Spawn wizard window ───────────────────────────────────────────
    const APP_ICON = path.join(__dirname, "..", "assets", "icon.ico");
    wizardWin = new BrowserWindow({
      width: 720,
      height: 720,
      minWidth: 640,
      minHeight: 580,
      icon: fs.existsSync(APP_ICON) ? APP_ICON : undefined,
      frame: true,
      autoHideMenuBar: true,
      resizable: true,
      maximizable: false,
      minimizable: false,
      backgroundColor: "#050c17",
      title: "ADSI Inverter Dashboard — Restore from Backup",
      modal: !!parentWin,
      parent: parentWin || undefined,
      center: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-bootstrap-restore.js"),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
      },
    });

    const wizardHtml = path.join(__dirname, "..", "public", "bootstrap-restore.html");
    let htmlLoaded = false;

    // Fix #5: surface load failures explicitly. did-fail-load fires for
    // file:// load errors — show a native error and resolve.
    wizardWin.webContents.on("did-fail-load", (_e, errCode, errDesc, url) => {
      if (htmlLoaded) return; // ignore later sub-resource fails
      const msg = `Wizard UI failed to load (${errCode} ${errDesc} at ${url}).`;
      console.error("[bootstrapRestore]", msg);
      try { dialog.showErrorBox("Restore Wizard Unavailable", msg); } catch (_) {}
      settle({ ok: false, error: msg });
      if (wizardWin && !wizardWin.isDestroyed()) {
        try { wizardWin.close(); } catch (_) { /* ignore */ }
      }
    });
    wizardWin.webContents.on("did-finish-load", () => { htmlLoaded = true; });

    wizardWin.loadFile(wizardHtml).catch((err) => {
      const msg = `Wizard UI load threw: ${err.message}`;
      console.error("[bootstrapRestore]", msg);
      try { dialog.showErrorBox("Restore Wizard Unavailable", msg); } catch (_) {}
      settle({ ok: false, error: msg });
      if (wizardWin && !wizardWin.isDestroyed()) {
        try { wizardWin.close(); } catch (_) { /* ignore */ }
      }
    });

    wizardWin.once("ready-to-show", () => {
      if (wizardWin && !wizardWin.isDestroyed()) wizardWin.show();
    });

    // Fix #2 (defense-in-depth): intercept window close during restore.
    // If the user clicks the title-bar X mid-restore, we'd otherwise resolve
    // the outer promise as canceled while the restore continues writing to
    // PROGRAMDATA in the background, racing the next license-prompt iteration.
    wizardWin.on("close", (e) => {
      if (restoreInFlight) {
        e.preventDefault();
        try {
          dialog.showMessageBoxSync(wizardWin, {
            type: "info",
            buttons: ["OK"],
            defaultId: 0,
            title: "Restore In Progress",
            message: "Please wait — the restore is still running.",
            detail: "The window will close automatically when restore finishes.",
          });
        } catch (_) { /* ignore */ }
      }
    });

    wizardWin.on("closed", () => {
      wizardWin = null;
      try { ipcMain.removeListener(IPC.COMPLETE, onWizardComplete); } catch (_) {}
      // If a restore actually succeeded (user X-closed step 5 instead of
      // clicking Relaunch), the DB has already been overwritten.  We MUST
      // relaunch — the half-state where the wizard exits as "canceled" but
      // PROGRAMDATA is freshly restored would leave the user staring at a
      // license prompt with no clue that their data is already in place.
      if (restoreSucceeded) {
        settle({
          ok: true,
          restored: true,
          willRelaunch: true,
          scope: lastRestoredScope,
        });
      } else {
        settle({ ok: true, canceled: true });
      }
    });

    return completion;
  })().finally(() => {
    unregisterIpcHandlers();
    activeBootstrapPromise = null;
    restoreInFlight = false;
  });

  return activeBootstrapPromise;
}

module.exports = {
  runBootstrapRestoreFlow,
  // Exported for tests:
  SCOPE_DEFINITIONS,
  assertValidAdsibakPath,
  ensureProgramDataRootWritable,
};
