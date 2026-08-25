"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CloudBackupService = require("../cloudBackup");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-cloud-backup-"));
  try {
    const dataDir = path.join(root, "data");
    const programDataDir = path.join(root, "programdata");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(programDataDir, { recursive: true });

    const sourceDb = path.join(root, "source-adsi.db");
    writeFile(sourceDb, "db-backup");
    writeFile(path.join(dataDir, "adsi.db"), "db-before-restore");
    writeFile(path.join(dataDir, "logs", "dashboard.log"), "dashboard-log");
    writeFile(
      path.join(programDataDir, "forecast", "pv_dayahead_model_bundle.joblib"),
      "forecast-model",
    );
    writeFile(
      path.join(programDataDir, "history", "context", "global", "global.json"),
      '{"history":true}',
    );
    writeFile(path.join(programDataDir, "weather", "cache.json"), '{"weather":true}');
    writeFile(
      path.join(programDataDir, "logs", "forecast_dayahead.log"),
      "forecast-log-original",
    );

    const settingsStore = new Map();
    const service = new CloudBackupService({
      dataDir,
      backupDir: path.join(root, "cloud_backups"),
      historyFile: path.join(root, "cloud_backup_history.json"),
      db: {
        backup: async (dest) => {
          fs.copyFileSync(sourceDb, dest);
        },
      },
      getSetting: (key, fallback = null) =>
        settingsStore.has(key) ? settingsStore.get(key) : fallback,
      setSetting: (key, value) => {
        settingsStore.set(key, value);
      },
      tokenStore: {
        isConnected: () => false,
        listConnected: () => [],
      },
      onedrive: null,
      gdrive: null,
      s3: null,
      poller: {
        isRunning: () => false,
      },
      ipConfigPath: null,
      programDataDir,
    });

    const created = await service.createLocalBackup({
      scope: ["database", "logs"],
      tag: "forecast-data-test",
    });
    const backupDir = created.dir;

    assert(fs.existsSync(path.join(backupDir, "adsi.db")));
    assert(fs.existsSync(path.join(backupDir, "forecast", "pv_dayahead_model_bundle.joblib")));
    assert(fs.existsSync(path.join(backupDir, "history", "context", "global", "global.json")));
    assert(fs.existsSync(path.join(backupDir, "weather", "cache.json")));
    assert(fs.existsSync(path.join(backupDir, "logs", "forecast_dayahead.log")));
    assert(
      created.manifest.files.some((item) => item.name === "history/context/global/global.json"),
      "backup manifest should include forecast training history artifacts",
    );

    writeFile(
      path.join(programDataDir, "forecast", "pv_dayahead_model_bundle.joblib"),
      "stale-forecast-model",
    );
    writeFile(
      path.join(programDataDir, "history", "context", "global", "global.json"),
      '{"history":false}',
    );
    writeFile(path.join(programDataDir, "weather", "cache.json"), '{"weather":false}');
    writeFile(
      path.join(programDataDir, "logs", "forecast_dayahead.log"),
      "forecast-log-overwritten",
    );

    service._setProgress({ status: "done", pct: 100, message: "ready-for-restore" });
    await service.restoreBackup(created.id, { skipSafetyBackup: true });

    assert.equal(
      fs.readFileSync(path.join(dataDir, "adsi.db"), "utf8"),
      "db-backup",
      "database should be restored from the local package",
    );
    assert.equal(
      fs.readFileSync(
        path.join(programDataDir, "forecast", "pv_dayahead_model_bundle.joblib"),
        "utf8",
      ),
      "forecast-model",
      "forecast model bundle should be restored",
    );
    assert.equal(
      fs.readFileSync(
        path.join(programDataDir, "history", "context", "global", "global.json"),
        "utf8",
      ),
      '{"history":true}',
      "forecast history context should be restored",
    );
    assert.equal(
      fs.readFileSync(path.join(programDataDir, "weather", "cache.json"), "utf8"),
      '{"weather":true}',
      "weather cache should be restored",
    );
    assert.equal(
      fs.readFileSync(path.join(programDataDir, "logs", "forecast_dayahead.log"), "utf8"),
      "forecast-log-original",
      "forecast log should be restored when log scope is included",
    );

    console.log("cloudBackupForecastData.test.js: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error("cloudBackupForecastData.test.js: FAIL");
  console.error(err);
  process.exitCode = 1;
});
