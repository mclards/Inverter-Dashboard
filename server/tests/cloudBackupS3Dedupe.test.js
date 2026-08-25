"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CloudBackupService = require("../cloudBackup");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function chunkKeyFor(content) {
  const hash = sha256Buffer(Buffer.from(content));
  return `objects/chunks/${hash.slice(0, 2)}/${hash}`;
}

class FakeS3Adapter {
  constructor() {
    this.objects = new Map();
    this.uploadedChunkKeys = [];
    this.uploadedFileKeys = [];
  }

  isConnected() {
    return true;
  }

  async objectExists(remoteName) {
    return this.objects.has(remoteName);
  }

  async uploadBuffer(buffer, remoteName) {
    const data = Buffer.isBuffer(buffer) ? Buffer.from(buffer) : Buffer.from(buffer || "");
    this.objects.set(remoteName, data);
    this.uploadedChunkKeys.push(remoteName);
    return { id: remoteName, name: path.basename(remoteName), size: data.length };
  }

  async uploadFile(localPath, remoteName) {
    const data = fs.readFileSync(localPath);
    this.objects.set(remoteName, data);
    this.uploadedFileKeys.push(remoteName);
    return { id: remoteName, name: path.basename(remoteName), size: data.length };
  }

  async listBackupFiles(backupId) {
    return Array.from(this.objects.keys())
      .filter((key) => key.startsWith(`${backupId}/`))
      .map((key) => ({
        id: key,
        name: key.slice(backupId.length + 1),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async downloadBuffer(remoteKey) {
    const data = this.objects.get(remoteKey);
    if (!data) throw new Error(`missing object: ${remoteKey}`);
    return Buffer.from(data);
  }

  async downloadFile(remoteKey, localPath) {
    const data = this.objects.get(remoteKey);
    if (!data) throw new Error(`missing object: ${remoteKey}`);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, data);
    return { size: data.length };
  }
}

function createService({ root, sourceDbPath, s3 }) {
  const dataDir = path.join(root, "data");
  const programDataDir = path.join(root, "programdata");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(programDataDir, { recursive: true });
  // v2.8.9 fix (2026-04-15): explicit backupDir injection to bypass the
  // storagePaths fallback that otherwise redirects to the real production
  // %PROGRAMDATA%\InverterDashboard\cloud_backups on a developer machine.
  const backupDir = path.join(dataDir, "cloud_backups");
  const historyFile = path.join(dataDir, "backup_history.json");
  const settingsStore = new Map();
  const service = new CloudBackupService({
    dataDir,
    backupDir,
    historyFile,
    db: {
      backup: async (dest) => {
        fs.copyFileSync(sourceDbPath, dest);
      },
    },
    getSetting: (key, fallback = null) =>
      settingsStore.has(key) ? settingsStore.get(key) : fallback,
    setSetting: (key, value) => {
      settingsStore.set(key, value);
    },
    tokenStore: {
      isConnected: (provider) => provider === "s3",
      listConnected: () => [{ provider: "s3", connectedAt: Date.now(), expired: false }],
    },
    onedrive: null,
    gdrive: null,
    s3,
    poller: {
      isRunning: () => false,
    },
    ipConfigPath: null,
    programDataDir,
  });
  return { service, dataDir, programDataDir };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-cloud-s3-dedupe-"));
  try {
    const uploadRoot = path.join(root, "upload");
    const pullRoot = path.join(root, "pull");
    const sourceDb = path.join(root, "source-adsi.db");
    const s3 = new FakeS3Adapter();

    const { service: uploadService, programDataDir: uploadProgramDataDir } = createService({
      root: uploadRoot,
      sourceDbPath: sourceDb,
      s3,
    });

    writeFile(sourceDb, "db-v1");
    writeFile(
      path.join(uploadProgramDataDir, "forecast", "pv_dayahead_model_bundle.joblib"),
      "forecast-model",
    );
    writeFile(
      path.join(uploadProgramDataDir, "history", "context", "global", "global.json"),
      '{"history":true}',
    );
    writeFile(path.join(uploadProgramDataDir, "weather", "cache.json"), '{"weather":true}');

    const backup1 = await uploadService.createLocalBackup({
      scope: ["database"],
      tag: "s3-dedupe-1",
    });
    await uploadService.uploadToCloud(backup1.id, ["s3"]);

    writeFile(sourceDb, "db-v2");
    const backup2 = await uploadService.createLocalBackup({
      scope: ["database"],
      tag: "s3-dedupe-2",
    });
    await uploadService.uploadToCloud(backup2.id, ["s3"]);

    const forecastChunkKey = chunkKeyFor("forecast-model");
    const historyChunkKey = chunkKeyFor('{"history":true}');
    const weatherChunkKey = chunkKeyFor('{"weather":true}');

    assert.equal(
      s3.uploadedChunkKeys.filter((key) => key === forecastChunkKey).length,
      1,
      "forecast chunk should only be uploaded once across backups",
    );
    assert.equal(
      s3.uploadedChunkKeys.filter((key) => key === historyChunkKey).length,
      1,
      "forecast history chunk should only be uploaded once across backups",
    );
    assert.equal(
      s3.uploadedChunkKeys.filter((key) => key === weatherChunkKey).length,
      1,
      "weather cache chunk should only be uploaded once across backups",
    );
    assert(
      s3.uploadedChunkKeys.length >= 5,
      "expected uploaded chunks for two database versions plus static forecast files",
    );

    const { service: pullService, dataDir: pullDataDir, programDataDir: pullProgramDataDir } = createService({
      root: pullRoot,
      sourceDbPath: sourceDb,
      s3,
    });

    await pullService.pullFromCloud("s3", backup2.id, backup2.id);
    const pulledDir = path.join(pullDataDir, "cloud_backups", backup2.id);
    assert.equal(fs.readFileSync(path.join(pulledDir, "adsi.db"), "utf8"), "db-v2");
    assert.equal(
      fs.readFileSync(
        path.join(pulledDir, "forecast", "pv_dayahead_model_bundle.joblib"),
        "utf8",
      ),
      "forecast-model",
    );
    assert.equal(
      fs.readFileSync(path.join(pulledDir, "history", "context", "global", "global.json"), "utf8"),
      '{"history":true}',
    );
    assert.equal(
      fs.readFileSync(path.join(pulledDir, "weather", "cache.json"), "utf8"),
      '{"weather":true}',
    );

    await pullService.restoreBackup(backup2.id, { skipSafetyBackup: true });
    assert.equal(fs.readFileSync(path.join(pullDataDir, "adsi.db"), "utf8"), "db-v2");
    assert.equal(
      fs.readFileSync(
        path.join(pullProgramDataDir, "forecast", "pv_dayahead_model_bundle.joblib"),
        "utf8",
      ),
      "forecast-model",
    );
    assert.equal(
      fs.readFileSync(path.join(pullProgramDataDir, "history", "context", "global", "global.json"), "utf8"),
      '{"history":true}',
    );
    assert.equal(
      fs.readFileSync(path.join(pullProgramDataDir, "weather", "cache.json"), "utf8"),
      '{"weather":true}',
    );

    console.log("cloudBackupS3Dedupe.test.js: PASS");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error("cloudBackupS3Dedupe.test.js: FAIL");
  console.error(err);
  process.exitCode = 1;
});
