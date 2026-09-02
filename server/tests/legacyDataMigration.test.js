"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const {
  REQUEST_FILE_NAME,
  runRequestedLegacyMigration,
  sha256File,
  validateTopology,
} = require("../../electron/legacyDataMigration");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createDb(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.exec(`
      CREATE TABLE readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        inverter INTEGER NOT NULL,
        unit INTEGER NOT NULL,
        pac REAL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE state (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const reading = db.prepare("INSERT INTO readings(id, ts, inverter, unit, pac) VALUES(?, ?, ?, ?, ?)");
    for (const row of rows.readings || []) reading.run(...row);
    const setting = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?)");
    for (const row of rows.settings || []) setting.run(...row);
    const state = db.prepare("INSERT INTO state(name, value) VALUES(?, ?)");
    for (const row of rows.state || []) state.run(...row);
  } finally {
    db.close();
  }
}

function createArchive(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    db.exec("CREATE TABLE readings(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, pac REAL)");
    const insert = db.prepare("INSERT INTO readings(id, ts, pac) VALUES(?, ?, ?)");
    for (const row of rows) insert.run(...row);
  } finally {
    db.close();
  }
}

function readRows(filePath, sql) {
  const db = new Database(filePath, { readonly: true });
  try {
    assert.strictEqual(db.prepare("PRAGMA quick_check(1)").pluck().get(), "ok");
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

function marker(targetRoot) {
  const request = path.join(targetRoot, "migration", REQUEST_FILE_NAME);
  fs.mkdirSync(path.dirname(request), { recursive: true });
  fs.writeFileSync(request, "test-request\n", "utf8");
  return request;
}

async function testContentAwareMerge() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-migration-"));
  try {
    const sourceRoot = path.join(tempRoot, "InverterDashboard");
    const targetRoot = path.join(tempRoot, "Inverter-Dashboard");
    const requestPath = marker(targetRoot);

    createDb(path.join(sourceRoot, "db", "adsi.db"), {
      readings: [
        [1, 2000, 1, 1, 22.5],
        [2, 3000, 2, 2, 30.5],
      ],
      settings: [["mode", "legacy"], ["legacy_only", "kept"]],
      state: [["cursor", "legacy"]],
    });
    createDb(path.join(targetRoot, "db", "adsi.db"), {
      readings: [[1, 1000, 1, 1, 10.5]],
      settings: [["mode", "current"]],
      state: [["cursor", "current"]],
    });
    createArchive(path.join(sourceRoot, "archive", "2026-08.db"), [
      [1, 2000, 20],
      [2, 3000, 30],
    ]);
    createArchive(path.join(targetRoot, "db", "archive", "2026-08.db"), [[1, 1000, 10]]);

    const sourceTopology = {
      inverters: { "1": "192.168.1.101", "2": "192.168.1.102" },
      poll_interval: { "1": 0.05, "2": 0.1 },
      units: { "1": [1, 2], "2": [] },
      losses: { "1": 2.5, "2": 1.5 },
    };
    const currentTopology = {
      inverters: { "1": "10.0.0.1" },
      poll_interval: { "1": 0.2 },
      units: { "1": [4] },
      losses: { "1": 9 },
    };
    writeJson(path.join(sourceRoot, "db", "ipconfig.json"), sourceTopology);
    writeJson(path.join(targetRoot, "db", "ipconfig.json"), currentTopology);

    fs.mkdirSync(path.join(sourceRoot, "weather"), { recursive: true });
    fs.mkdirSync(path.join(targetRoot, "weather"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "weather", "history.csv"), "legacy\n", "utf8");
    fs.writeFileSync(path.join(targetRoot, "weather", "history.csv"), "current\n", "utf8");
    fs.writeFileSync(path.join(sourceRoot, "weather", "same.csv"), "same\n", "utf8");
    fs.writeFileSync(path.join(targetRoot, "weather", "same.csv"), "same\n", "utf8");

    fs.mkdirSync(path.join(sourceRoot, "auth"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "auth", ".token-keyring"), "legacy-key", "utf8");

    const result = await runRequestedLegacyMigration({
      Database,
      sourceRoot,
      targetRoot,
      requestPath,
      now: () => Date.UTC(2026, 8, 2, 1, 2, 3, 456),
    });

    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.status, "complete-with-conflicts");
    assert.strictEqual(fs.existsSync(requestPath), false, "successful migration must clear its request");
    assert.ok(fs.existsSync(result.manifestPath), "audit manifest must be retained");

    const readings = readRows(
      path.join(targetRoot, "db", "adsi.db"),
      "SELECT id, ts, inverter, unit, pac FROM readings ORDER BY id",
    );
    assert.deepStrictEqual(readings.map((row) => row.ts), [1000, 3000, 2000]);
    assert.strictEqual(new Set(readings.map((row) => row.ts)).size, 3, "all distinct history rows must survive");
    const settings = readRows(
      path.join(targetRoot, "db", "adsi.db"),
      "SELECT key, value FROM settings ORDER BY key",
    );
    assert.deepStrictEqual(settings, [
      { key: "legacy_only", value: "kept" },
      { key: "mode", value: "current" },
    ]);
    assert.deepStrictEqual(readRows(
      path.join(targetRoot, "db", "adsi.db"),
      "SELECT name, value FROM state",
    ), [{ name: "cursor", value: "current" }]);

    const archiveRows = readRows(
      path.join(targetRoot, "db", "archive", "2026-08.db"),
      "SELECT id, ts, pac FROM readings ORDER BY id",
    );
    assert.deepStrictEqual(archiveRows.map((row) => row.ts), [1000, 3000, 2000]);

    const mergedTopology = JSON.parse(fs.readFileSync(path.join(targetRoot, "db", "ipconfig.json"), "utf8"));
    assert.deepStrictEqual(validateTopology(mergedTopology), { ok: true });
    assert.strictEqual(mergedTopology.inverters["1"], "10.0.0.1", "current IP must win a conflict");
    assert.deepStrictEqual(mergedTopology.units["1"], [4], "current node assignment must be preserved");
    assert.strictEqual(mergedTopology.inverters["2"], "192.168.1.102", "missing inverter must be imported");
    assert.deepStrictEqual(mergedTopology.units["2"], [], "explicitly disabled nodes must remain disabled");

    assert.strictEqual(fs.readFileSync(path.join(targetRoot, "weather", "history.csv"), "utf8"), "current\n");
    assert.strictEqual(
      result.files.find((item) => item.source.endsWith("history.csv")).action,
      "conflict-preserved",
    );
    assert.strictEqual(result.files.find((item) => item.source.endsWith("same.csv")).action, "identical");
    assert.strictEqual(fs.readFileSync(path.join(targetRoot, "db", ".token-keyring"), "utf8"), "legacy-key");
    assert.ok(result.databases.every((item) => item.destinationBackup), "existing databases need rollback snapshots");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testCorruptSourceDoesNotModifyTargetAndRetries() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-migration-corrupt-"));
  try {
    const sourceRoot = path.join(tempRoot, "InverterDashboard");
    const targetRoot = path.join(tempRoot, "Inverter-Dashboard");
    const requestPath = marker(targetRoot);
    fs.mkdirSync(path.join(sourceRoot, "db"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, "db", "adsi.db"), "not-a-sqlite-database", "utf8");
    createDb(path.join(targetRoot, "db", "adsi.db"), {
      readings: [[1, 1000, 1, 1, 10]],
      settings: [["mode", "current"]],
      state: [],
    });
    const beforeHash = sha256File(path.join(targetRoot, "db", "adsi.db"));
    const result = await runRequestedLegacyMigration({ Database, sourceRoot, targetRoot, requestPath });
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(fs.existsSync(requestPath), true, "failed migration must remain retryable");
    assert.strictEqual(sha256File(path.join(targetRoot, "db", "adsi.db")), beforeHash);
    assert.ok(result.errors.some((item) => item.artifact === "adsi.db"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function testTableFailureRollsBackWholeDatabase() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-migration-rollback-"));
  try {
    const sourceRoot = path.join(tempRoot, "InverterDashboard");
    const targetRoot = path.join(tempRoot, "Inverter-Dashboard");
    const requestPath = marker(targetRoot);
    createDb(path.join(sourceRoot, "db", "adsi.db"), {
      readings: [[2, 2000, 1, 1, 20]],
      settings: [["legacy_only", "would-have-been-added"]],
      state: [],
    });
    createDb(path.join(targetRoot, "db", "adsi.db"), {
      readings: [[1, 1000, 1, 1, 10]],
      settings: [["mode", "current"]],
      state: [],
    });
    const source = new Database(path.join(sourceRoot, "db", "adsi.db"));
    const target = new Database(path.join(targetRoot, "db", "adsi.db"));
    try {
      source.exec("CREATE TABLE incompatible(id INTEGER PRIMARY KEY); INSERT INTO incompatible(id) VALUES(1)");
      target.exec("CREATE TABLE incompatible(id INTEGER PRIMARY KEY, required TEXT NOT NULL)");
    } finally {
      source.close();
      target.close();
    }

    const result = await runRequestedLegacyMigration({ Database, sourceRoot, targetRoot, requestPath });
    assert.strictEqual(result.status, "failed");
    assert.strictEqual(fs.existsSync(requestPath), true);
    assert.deepStrictEqual(readRows(
      path.join(targetRoot, "db", "adsi.db"),
      "SELECT id, ts FROM readings ORDER BY id",
    ), [{ id: 1, ts: 1000 }], "a later table failure must roll back earlier row inserts");
    assert.deepStrictEqual(readRows(
      path.join(targetRoot, "db", "adsi.db"),
      "SELECT key, value FROM settings ORDER BY key",
    ), [{ key: "mode", value: "current" }]);
    assert.ok(result.databases[0].rolledBack);
    assert.ok(fs.existsSync(result.databases[0].destinationBackup));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function testInstallerAndStartupWiring() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const installer = fs.readFileSync(path.join(repoRoot, "scripts", "installer.nsh"), "utf8");
  const main = fs.readFileSync(path.join(repoRoot, "electron", "main.js"), "utf8");
  assert.ok(installer.includes(REQUEST_FILE_NAME), "NSIS must queue the versioned import request");
  assert.ok(!/CopyFiles[^\r\n]*InverterDashboard\\(?:db|archive|forecast|weather|license|auth)/i.test(installer),
    "NSIS must not copy legacy data by filename");
  const migrationCall = main.indexOf("await runInstallerRequestedLegacyMigration()");
  const readyHandler = main.indexOf("app.whenReady().then(async () =>");
  const loginStart = main.indexOf("showLoginWindow()", readyHandler);
  assert.ok(migrationCall > readyHandler, "migration must run inside app-ready startup");
  assert.ok(loginStart > migrationCall, "migration must finish before login can start local services");
}

(async () => {
  await testContentAwareMerge();
  await testCorruptSourceDoesNotModifyTargetAndRetries();
  await testTableFailureRollsBackWholeDatabase();
  testInstallerAndStartupWiring();
  console.log("legacyDataMigration.test.js: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
