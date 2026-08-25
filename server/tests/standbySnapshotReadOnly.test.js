"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-standby-snapshot-"),
  );
}
if (!process.env.ADSI_SERVER_PORT) process.env.ADSI_SERVER_PORT = "3516";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});

const APP_BASE_URL = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT || 3516)}`;

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function waitFor(fn, timeoutMs = 15000, stepMs = 100) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fn()) return true;
    await waitMs(stepMs);
  }
  return false;
}

async function fetchReady(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response;
}

function listArchiveTransferSnapshots(archiveDir) {
  try {
    return fs
      .readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.includes(".transfer-snapshot-"))
      .map((entry) => entry.name)
      .sort();
  } catch (_) {
    return [];
  }
}

async function run() {
  const dbMod = require("../db.js");
  const serverMod = require("../index.js");
  const today = dbMod.localDateStr();
  const snapshotDownloadPath = path.join(dbMod.DATA_DIR, "main-db-export-check.db");
  const archiveFileName = "2025-11.db";
  const archiveFilePath = path.join(dbMod.ARCHIVE_DIR, archiveFileName);

  try {
    await fetchReady(`${APP_BASE_URL}/api/settings`).catch(async () => {
      const ready = await waitFor(async () => {
        try {
          await fetchReady(`${APP_BASE_URL}/api/settings`);
          return true;
        } catch (_) {
          return false;
        }
      }, 15000, 200);
      if (!ready) throw new Error("App server did not become ready.");
    });

    dbMod.db.prepare("DELETE FROM daily_report WHERE date=?").run(today);
    dbMod.db.prepare("DELETE FROM energy_5min WHERE inverter=?").run(1);
    dbMod.db
      .prepare("INSERT INTO energy_5min(ts,inverter,kwh_inc) VALUES(?,?,?)")
      .run(Date.now(), 1, 1.234567);

    const exportResponse = await fetch(`${APP_BASE_URL}/api/replication/main-db`, {
      headers: { "Accept-Encoding": "identity" },
    });
    assert.equal(exportResponse.ok, true, "main DB export should succeed");
    fs.writeFileSync(
      snapshotDownloadPath,
      Buffer.from(await exportResponse.arrayBuffer()),
    );

    const liveDailyReportCount = Number(
      dbMod.db
        .prepare("SELECT COUNT(*) AS cnt FROM daily_report WHERE date=? AND inverter=?")
        .get(today, 1)?.cnt || 0,
    );
    assert.equal(
      liveDailyReportCount,
      0,
      "main DB export should not write daily_report rows into the live gateway DB",
    );

    const snapshotDb = new Database(snapshotDownloadPath, { readonly: true, fileMustExist: true });
    try {
      const snapshotRow = snapshotDb
        .prepare("SELECT kwh_total FROM daily_report WHERE date=? AND inverter=?")
        .get(today, 1);
      assert.equal(
        Number(snapshotRow?.kwh_total || 0) > 0,
        true,
        "downloaded snapshot should still include the computed today report row",
      );
    } finally {
      snapshotDb.close();
    }

    try { fs.unlinkSync(archiveFilePath); } catch (_) {}
    const archiveDb = new Database(archiveFilePath);
    try {
      archiveDb.exec("CREATE TABLE IF NOT EXISTS marker(v INTEGER); INSERT INTO marker(v) VALUES (1);");
    } finally {
      archiveDb.close();
    }

    const archiveBefore = listArchiveTransferSnapshots(dbMod.ARCHIVE_DIR);
    assert.deepEqual(archiveBefore, [], "archive dir should start without transfer snapshots");

    const archiveResponse = await fetch(
      `${APP_BASE_URL}/api/replication/archive-download?file=${encodeURIComponent(archiveFileName)}`,
      { headers: { "Accept-Encoding": "identity" } },
    );
    assert.equal(archiveResponse.ok, true, "archive download should succeed");
    await archiveResponse.arrayBuffer();

    const archiveSnapshotCleaned = await waitFor(
      () => listArchiveTransferSnapshots(dbMod.ARCHIVE_DIR).length === 0,
      5000,
      100,
    );
    assert.equal(
      archiveSnapshotCleaned,
      true,
      "archive download should clean its temporary transfer snapshot",
    );

    console.log("standbySnapshotReadOnly.test.js: PASS");
  } finally {
    try {
      fs.unlinkSync(snapshotDownloadPath);
    } catch (_) {}
    try {
      await Promise.race([
        serverMod.shutdownEmbedded(),
        waitMs(4000),
      ]);
    } catch (_) {}
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("standbySnapshotReadOnly.test.js: FAIL", err?.stack || err);
    process.exit(1);
  });
