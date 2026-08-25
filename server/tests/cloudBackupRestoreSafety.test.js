"use strict";

// v2.8.14 regression tests:
//   C-1: cloud restore must delete stale -wal / -shm files BEFORE fs.copyFileSync
//        so SQLite cannot replay an old WAL against the freshly restored DB.
//   R5:  auto-rollback on partial restore failure must restore the pre-restore
//        safety backup and re-throw a "rolledBack" error.
//   R6:  recovery.log present at dataDir/logs/recovery.log must end up in the
//        portable .adsibak (or its precursor local backup with logs scope).
//   R3:  manifest must include rowCounts when database scope is enabled.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CloudBackupService = require("../cloudBackup");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function buildService({ root, dbBackupBytes, rowCounts = null }) {
  const dataDir = path.join(root, "data");
  const programDataDir = path.join(root, "programdata");
  // CRITICAL: pass an explicit backupDir so the service does NOT fall back to
  // the real `%PROGRAMDATA%\InverterDashboard\cloud_backups` (see the comment
  // at cloudBackup.js:131-139 about the existing backupDir override).
  const backupDir = path.join(root, "cloud_backups");
  const historyFile = path.join(root, "backup_history.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(programDataDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const sourceDb = path.join(root, "source-adsi.db");
  fs.writeFileSync(sourceDb, dbBackupBytes);
  fs.writeFileSync(path.join(dataDir, "adsi.db"), "live-db-before-restore");

  const settingsStore = new Map();

  // Mock better-sqlite3 db handle. Only `backup`, `prepare(...).get`, and
  // pragma are exercised by the restore + manifest paths under test.
  // Intentionally OMIT `exec` and `transaction` so the inner copy-fallback
  // in _restoreBackupLocked (`_restoreDbViaAttach`) is bypassed and a copy
  // failure surfaces directly — mirroring a real production env where the DB
  // handle is closed/unusable when fs.copyFileSync fails on the open file.
  const fakeDb = {
    backup: async (dest) => {
      fs.copyFileSync(sourceDb, dest);
    },
    prepare: (sql) => {
      if (rowCounts && /^SELECT COUNT\(\*\) AS n FROM (\w+)/i.test(sql)) {
        const t = sql.match(/FROM (\w+)/i)[1];
        const n = rowCounts[t];
        if (n == null) throw new Error("no such table");
        return { get: () => ({ n }) };
      }
      return { get: () => null, all: () => [] };
    },
    pragma: () => {},
  };

  const svc = new CloudBackupService({
    dataDir,
    db: fakeDb,
    getSetting: (k, fb = null) => (settingsStore.has(k) ? settingsStore.get(k) : fb),
    setSetting: (k, v) => { settingsStore.set(k, v); },
    tokenStore: { isConnected: () => false, listConnected: () => [] },
    onedrive: null,
    gdrive: null,
    s3: null,
    poller: { isRunning: () => false },
    ipConfigPath: null,
    programDataDir,
    backupDir,
    historyFile,
  });
  return { svc, dataDir, programDataDir, backupDir };
}

async function testWalShmCleanup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-c1-"));
  try {
    const { svc, dataDir } = buildService({ root, dbBackupBytes: "fresh-db-bytes" });

    // Plant stale WAL + SHM files next to live adsi.db. These would normally
    // be left behind when the previous DB was opened in WAL mode. If the
    // restore copies adsi.db without first removing them, a real SQLite open
    // would replay them against the new file → silent corruption.
    const liveDb = path.join(dataDir, "adsi.db");
    fs.writeFileSync(`${liveDb}-wal`, "stale-wal");
    fs.writeFileSync(`${liveDb}-shm`, "stale-shm");

    // Create a backup package, then restore it.
    const created = await svc.createLocalBackup({ scope: ["database"], tag: "c1-test" });
    svc._setProgress({ status: "done", pct: 100, message: "ready" });
    await svc.restoreBackup(created.id, { skipSafetyBackup: true });

    // After restore, both -wal and -shm must be gone.
    assert.ok(!fs.existsSync(`${liveDb}-wal`), "C-1: stale -wal should be deleted before copy");
    assert.ok(!fs.existsSync(`${liveDb}-shm`), "C-1: stale -shm should be deleted before copy");
    assert.equal(
      fs.readFileSync(liveDb, "utf8"),
      "fresh-db-bytes",
      "C-1: live DB should be the freshly restored bytes",
    );

    console.log("  • C-1 WAL/SHM cleanup: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testAutoRollback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-r5-"));
  try {
    const { svc, dataDir } = buildService({ root, dbBackupBytes: "intended-restore" });
    const liveDb = path.join(dataDir, "adsi.db");
    const originalContents = fs.readFileSync(liveDb, "utf8");

    // Create the backup we'll later try to restore.
    const created = await svc.createLocalBackup({
      scope: ["database", "config"],
      tag: "r5-target",
    });
    svc._setProgress({ status: "done", pct: 100, message: "ready" });

    // Sabotage: force ONLY the FIRST live-DB overwrite to throw. The rollback
    // restore that follows must succeed (otherwise we'd hit the catastrophic
    // path, which is a separate test case). One-shot flag handles this.
    const realCopy = fs.copyFileSync;
    let liveCopyThrowArmed = true;
    fs.copyFileSync = function patchedCopy(src, dst) {
      if (liveCopyThrowArmed && path.resolve(String(dst)) === path.resolve(liveDb)) {
        liveCopyThrowArmed = false;
        throw new Error("simulated mid-restore disk failure");
      }
      return realCopy.call(fs, src, dst);
    };

    let thrown = null;
    try {
      await svc.restoreBackup(created.id);
    } catch (err) {
      thrown = err;
    } finally {
      fs.copyFileSync = realCopy;
    }

    assert.ok(thrown, "restore should have thrown");
    assert.ok(
      thrown.rolledBack === true,
      `expected thrown.rolledBack=true, got ${thrown.rolledBack}: ${thrown.message}`,
    );
    assert.match(
      thrown.message,
      /rolled back/i,
      "thrown error should announce rollback",
    );
    assert.ok(
      thrown.cause,
      "rolled-back error should preserve the original cause",
    );
    assert.match(
      String(thrown.cause?.message || ""),
      /simulated mid-restore disk failure/,
      "cause should reference the original failure",
    );

    console.log("  • R5 auto-rollback on restore failure: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRecoveryLogIncluded() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-r6-"));
  try {
    const { svc, programDataDir } = buildService({ root, dbBackupBytes: "db-bytes" });
    // recovery.log lives under programDataDir/logs (electron/recoveryDialog.js
    // writes there). The backup must read from that canonical path.
    const recoveryLogPath = path.join(programDataDir, "logs", "recovery.log");
    writeFile(recoveryLogPath, "boot integrity ok\nrestore probe ok\n");

    const created = await svc.createLocalBackup({
      scope: ["database", "logs"],
      tag: "r6-recovery-log",
    });

    const dst = path.join(created.dir, "logs", "recovery.log");
    assert.ok(
      fs.existsSync(dst),
      "R6: recovery.log must be present in the backup package",
    );
    assert.equal(
      fs.readFileSync(dst, "utf8"),
      "boot integrity ok\nrestore probe ok\n",
      "R6: recovery.log contents should match",
    );
    assert.ok(
      created.manifest.checksums["logs/recovery.log"],
      "R6: manifest should contain a checksum for logs/recovery.log",
    );

    console.log("  • R6 recovery.log included in backup (from programDataDir): PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRestorePathsRoundTrip() {
  // v2.8.14 path-fix regression: when restoring, files must end up where the
  // app actually reads from. recovery.log → programDataDir/logs (not dataDir).
  // forecast_dayahead.log → programDataDir/logs. Other logs → dataDir/logs.
  // Database → dataDir/adsi.db. Forecast/history/weather → programDataDir/...
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-paths-"));
  try {
    const { svc, dataDir, programDataDir } = buildService({ root, dbBackupBytes: "fresh-db" });

    // Plant source files at their canonical pre-backup locations.
    writeFile(path.join(programDataDir, "logs", "recovery.log"), "RECOVERY-ENTRY");
    writeFile(path.join(programDataDir, "logs", "forecast_dayahead.log"), "FORECAST-LOG");
    writeFile(path.join(dataDir, "logs", "dashboard.log"), "DASHBOARD-LOG");

    // Create the backup (must capture all three files).
    const created = await svc.createLocalBackup({
      scope: ["database", "logs"],
      tag: "paths-roundtrip",
    });
    assert.ok(created.manifest.checksums["logs/recovery.log"], "recovery.log captured");
    assert.ok(created.manifest.checksums["logs/forecast_dayahead.log"], "forecast log captured");
    assert.ok(created.manifest.checksums["logs/dashboard.log"], "dashboard log captured");

    // Wipe destinations so we can prove the restore re-creates them.
    fs.rmSync(path.join(programDataDir, "logs"), { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, "logs"), { recursive: true, force: true });
    fs.unlinkSync(path.join(dataDir, "adsi.db"));

    svc._setProgress({ status: "done", pct: 100, message: "ready" });
    await svc.restoreBackup(created.id, { skipSafetyBackup: true });

    // Database must land in dataDir/adsi.db.
    assert.equal(
      fs.readFileSync(path.join(dataDir, "adsi.db"), "utf8"),
      "fresh-db",
      "database must restore to dataDir/adsi.db",
    );
    // recovery.log must land under programDataDir/logs (NOT dataDir/logs).
    assert.ok(
      fs.existsSync(path.join(programDataDir, "logs", "recovery.log")),
      "recovery.log must restore to programDataDir/logs (where electron/recoveryDialog reads it)",
    );
    assert.ok(
      !fs.existsSync(path.join(dataDir, "logs", "recovery.log")),
      "recovery.log must NOT be placed under dataDir/logs",
    );
    // forecast_dayahead.log similarly under programDataDir/logs.
    assert.ok(
      fs.existsSync(path.join(programDataDir, "logs", "forecast_dayahead.log")),
      "forecast_dayahead.log must restore to programDataDir/logs",
    );
    assert.ok(
      !fs.existsSync(path.join(dataDir, "logs", "forecast_dayahead.log")),
      "forecast_dayahead.log must NOT be placed under dataDir/logs",
    );
    // Other logs (dashboard.log) stay under dataDir/logs.
    assert.ok(
      fs.existsSync(path.join(dataDir, "logs", "dashboard.log")),
      "dashboard.log must restore to dataDir/logs",
    );
    assert.ok(
      !fs.existsSync(path.join(programDataDir, "logs", "dashboard.log")),
      "dashboard.log must NOT be placed under programDataDir/logs",
    );

    console.log("  • Restore destination paths round-trip correctly: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testManifestRowCounts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-r3-"));
  try {
    const rowCounts = {
      readings: 1234567,
      energy_5min: 89012,
      alarms: 42,
      audit_log: 0,
      forecast_run_audit: 5,
      solcast_snapshots: 240,
    };
    const { svc } = buildService({ root, dbBackupBytes: "db-bytes", rowCounts });

    const created = await svc.createLocalBackup({
      scope: ["database"],
      tag: "r3-rowcounts",
    });

    assert.ok(created.manifest.rowCounts, "R3: manifest should contain rowCounts");
    assert.equal(
      created.manifest.rowCounts.readings,
      1234567,
      "R3: readings count should match",
    );
    assert.equal(
      created.manifest.rowCounts.alarms,
      42,
      "R3: alarms count should match",
    );

    // R3 backwards compatibility: when rowCounts collection throws, manifest
    // should still be produced with rowCounts: null (not crash the backup).
    const { svc: svc2 } = buildService({
      root: fs.mkdtempSync(path.join(os.tmpdir(), "adsi-r3b-")),
      dbBackupBytes: "db-bytes",
      rowCounts: null,
    });
    const created2 = await svc2.createLocalBackup({ scope: ["database"], tag: "r3-no-rows" });
    assert.ok(
      "rowCounts" in created2.manifest,
      "R3: manifest must have rowCounts field even when empty",
    );

    console.log("  • R3 manifest row counts: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRestoreAbortsOnReadonlyDestination() {
  // v2.8.14: pre-restore writability probe must catch a read-only destination
  // BEFORE the safety backup is created. Simulate failure by monkey-patching
  // fs.writeFileSync to refuse writes into the forecast directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-probe-"));
  try {
    const { svc, programDataDir } = buildService({ root, dbBackupBytes: "db-bytes" });
    // Plant a forecast file so the manifest scope clearly includes the dir.
    writeFile(path.join(programDataDir, "forecast", "model.bin"), "model");

    const created = await svc.createLocalBackup({
      scope: ["database", "logs"],
      tag: "probe-test",
    });
    svc._setProgress({ status: "done", pct: 100, message: "ready" });

    const realWrite = fs.writeFileSync;
    const blockedDir = path.resolve(path.join(programDataDir, "forecast"));
    fs.writeFileSync = function patchedWrite(target, ...rest) {
      const tStr = String(target || "");
      if (path.resolve(path.dirname(tStr)) === blockedDir) {
        const err = new Error("EACCES: permission denied (simulated)");
        err.code = "EACCES";
        throw err;
      }
      return realWrite.call(fs, target, ...rest);
    };

    let thrown = null;
    try {
      await svc.restoreBackup(created.id, { skipSafetyBackup: true });
    } catch (err) {
      thrown = err;
    } finally {
      fs.writeFileSync = realWrite;
    }

    assert.ok(thrown, "restore should abort when a destination is read-only");
    assert.match(
      thrown.message,
      /Restore aborted — one or more destination directories are not writable/i,
      "error must explain why the restore aborted",
    );
    assert.match(
      thrown.message,
      /forecast directory/i,
      "error must name the offending directory",
    );

    console.log("  • Pre-restore writability probe aborts cleanly: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testScopeFilterSelectiveRestore() {
  // v2.8.14 bootstrap-restore feature: opts.scopeFilter must let the wizard
  // restore SOME scopes from a multi-scope backup while skipping others.
  // Workflow: create a backup with [database, config, logs], then restore
  // with scopeFilter=["database"] and prove config + logs were NOT touched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-scopefilter-"));
  try {
    const { svc, dataDir, programDataDir } = buildService({
      root,
      dbBackupBytes: "fresh-db-via-filter",
    });

    // Plant source files for all three scopes.
    writeFile(path.join(dataDir, "logs", "dashboard.log"), "BACKUP-LOG-CONTENT");
    writeFile(path.join(programDataDir, "logs", "recovery.log"), "BACKUP-RECOVERY");

    const created = await svc.createLocalBackup({
      scope: ["database", "logs"],
      tag: "scope-filter-test",
    });

    // Reset live state with DIFFERENT content so we can detect overwrite.
    fs.writeFileSync(path.join(dataDir, "adsi.db"), "old-db-must-be-overwritten");
    writeFile(path.join(dataDir, "logs", "dashboard.log"), "EXISTING-LOG-MUST-SURVIVE");
    writeFile(path.join(programDataDir, "logs", "recovery.log"), "EXISTING-RECOVERY-MUST-SURVIVE");

    svc._setProgress({ status: "done", pct: 100, message: "ready" });
    await svc.restoreBackup(created.id, {
      skipSafetyBackup: true,
      scopeFilter: ["database"],
    });

    // Database scope: must be restored.
    assert.equal(
      fs.readFileSync(path.join(dataDir, "adsi.db"), "utf8"),
      "fresh-db-via-filter",
      "database scope (in filter) should be restored",
    );
    // Logs scope: must NOT be restored — existing files must survive.
    assert.equal(
      fs.readFileSync(path.join(dataDir, "logs", "dashboard.log"), "utf8"),
      "EXISTING-LOG-MUST-SURVIVE",
      "logs scope (NOT in filter) must be skipped — existing dashboard.log preserved",
    );
    assert.equal(
      fs.readFileSync(path.join(programDataDir, "logs", "recovery.log"), "utf8"),
      "EXISTING-RECOVERY-MUST-SURVIVE",
      "logs scope (NOT in filter) must be skipped — existing recovery.log preserved",
    );

    console.log("  • Scope filter selective restore: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testScopeFilterEmptyArrayBlocksAll() {
  // Defensive contract: an explicit empty scopeFilter blocks every scope.
  // A null/undefined filter means "no filter — restore everything in manifest".
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-scopefilter-empty-"));
  try {
    const { svc, dataDir } = buildService({
      root,
      dbBackupBytes: "should-not-be-written",
    });
    writeFile(path.join(dataDir, "logs", "dashboard.log"), "BACKUP-LOG");

    const created = await svc.createLocalBackup({
      scope: ["database", "logs"],
      tag: "empty-filter",
    });

    fs.writeFileSync(path.join(dataDir, "adsi.db"), "untouched-live-db");
    writeFile(path.join(dataDir, "logs", "dashboard.log"), "untouched-log");

    svc._setProgress({ status: "done", pct: 100, message: "ready" });
    await svc.restoreBackup(created.id, {
      skipSafetyBackup: true,
      scopeFilter: [],
    });

    assert.equal(
      fs.readFileSync(path.join(dataDir, "adsi.db"), "utf8"),
      "untouched-live-db",
      "empty scopeFilter must skip database scope",
    );
    assert.equal(
      fs.readFileSync(path.join(dataDir, "logs", "dashboard.log"), "utf8"),
      "untouched-log",
      "empty scopeFilter must skip logs scope",
    );

    console.log("  • Scope filter empty array blocks all scopes: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  console.log("cloudBackupRestoreSafety.test.js:");
  await testWalShmCleanup();
  await testAutoRollback();
  await testRecoveryLogIncluded();
  await testManifestRowCounts();
  await testRestorePathsRoundTrip();
  await testRestoreAbortsOnReadonlyDestination();
  await testScopeFilterSelectiveRestore();
  await testScopeFilterEmptyArrayBlocksAll();
  console.log("cloudBackupRestoreSafety.test.js: PASS");
}

run().catch((err) => {
  console.error("cloudBackupRestoreSafety.test.js: FAIL");
  console.error(err);
  process.exitCode = 1;
});
