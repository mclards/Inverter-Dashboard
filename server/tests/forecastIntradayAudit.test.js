"use strict";

const assert = require("assert");
const crypto = require("crypto");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (process.argv.includes("--legacy-child")) {
  const Database = require("better-sqlite3");
  const dataDir = String(process.env.ADSI_DATA_DIR || "");
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyDb = new Database(path.join(dataDir, "adsi.db"));
  legacyDb.exec(`
    CREATE TABLE forecast_dayahead_immutable (
      generated_ts INTEGER NOT NULL,
      date TEXT NOT NULL,
      slot INTEGER NOT NULL,
      kwh_inc REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(generated_ts, date, slot)
    );
    INSERT INTO forecast_dayahead_immutable(generated_ts, date, slot, kwh_inc)
    VALUES (1000, '2026-05-01', 60, 12.5);
    CREATE TABLE forecast_intraday_adjusted (
      date TEXT NOT NULL, ts INTEGER NOT NULL, slot INTEGER NOT NULL,
      time_hms TEXT NOT NULL, kwh_inc REAL NOT NULL DEFAULT 0,
      kwh_lo REAL DEFAULT 0, kwh_hi REAL DEFAULT 0, source TEXT DEFAULT 'service',
      updated_ts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(date, slot)
    );
    CREATE TABLE forecast_intraday_run_audit (
      id INTEGER PRIMARY KEY, target_date TEXT NOT NULL, generated_ts INTEGER NOT NULL,
      cutoff_slot INTEGER NOT NULL, algorithm_version TEXT NOT NULL,
      execution_mode TEXT NOT NULL DEFAULT 'active', run_status TEXT NOT NULL DEFAULT 'success',
      UNIQUE(target_date, generated_ts)
    );
  `);
  legacyDb.close();

  const dbModule = require(path.join(__dirname, "..", "db.js"));
  const quarantine = dbModule.db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type='table' AND name LIKE 'forecast_dayahead_immutable_legacy_noncausal%'
     ORDER BY name LIMIT 1
  `).get();
  assert(quarantine?.name, "legacy immutable rows must be quarantined recoverably");
  assert.equal(
    dbModule.db.prepare(`SELECT COUNT(*) AS n FROM ${quarantine.name}`).get().n,
    1,
  );
  const migratedColumns = dbModule.db.prepare("PRAGMA table_info(forecast_dayahead_immutable)").all();
  assert(migratedColumns.some((column) => column.name === "issuance_id"));
  const migratedIntraday = dbModule.db.prepare("PRAGMA table_info(forecast_intraday_adjusted)").all();
  assert(migratedIntraday.some((column) => column.name === "series_run_id"));
  const migratedAudit = dbModule.db.prepare("PRAGMA table_info(forecast_intraday_run_audit)").all();
  for (const name of [
    "series_run_id",
    "output_updated_ts",
    "authoritative_algorithm",
    "challenger_status",
    "authoritative_write_status",
    "configured_mode",
    "prior_series_preserved",
  ]) {
    assert(migratedAudit.some((column) => column.name === name), `legacy migration missing ${name}`);
  }
  assert.equal(dbModule.db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead_immutable").get().n, 0);
  dbModule.closeDb();
  console.log("forecastIntradayAudit.test.js legacy child: PASS");
  process.exit(0);
}

const root = path.resolve(__dirname, "..", "..");
const uiSource = fs.readFileSync(path.join(root, "public", "js", "app.js"), "utf8");

function extractNamedFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `missing ${name}`);
  const signatureEnd = source.indexOf(") {", start);
  assert(signatureEnd >= 0, `missing ${name} body`);
  const braceStart = signatureEnd + 2;
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const buildNowcastDisplayModel = Function(
  `"use strict"; return (${extractNamedFunction(uiSource, "buildNowcastDisplayModel")});`,
)();
const unknownDisplay = buildNowcastDisplayModel(
  { series_kind: "intraday_adjusted", provenance_status: "unknown" },
  (value) => `formatted:${value}`,
);
assert.equal(unknownDisplay.algorithm, "unknown");
assert.equal(unknownDisplay.generatedLabel, "unknown");
assert.equal(unknownDisplay.summary, "off · plotted unknown");
const shadowDisplay = buildNowcastDisplayModel(
  {
    configured_mode: "shadow",
    series_kind: "intraday_adjusted",
    series_algorithm: "current_ratio_v1",
    series_generated_ts: 1234,
    provenance_status: "matched",
    challenger_meta: { algorithm_version: "robust_decay_v1", status: "success" },
  },
  (value) => `formatted:${value}`,
);
assert.equal(
  shadowDisplay.summary,
  "shadow · plotted current_ratio_v1 · challenger robust_decay_v1",
);
assert.equal(shadowDisplay.generatedLabel, "formatted:1234");
assert.equal(shadowDisplay.provenanceStatus, "matched");

// Exercise the real idempotent migration and retention statement. This part
// runs under the Node-ABI smoke phase after better-sqlite3 is rebuilt for Node.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-nowcast-audit-"));
const previousDataDir = process.env.ADSI_DATA_DIR;
try {
  process.env.ADSI_DATA_DIR = tmp;
  const dbModulePath = path.join(root, "server", "db.js");
  delete require.cache[require.resolve(dbModulePath)];
  const {
    db,
    stmts,
    closeDb,
    bulkUpsertForecastDayAhead,
    bulkUpsertForecastIntradayAdjusted,
  } = require(dbModulePath);
  const columns = db.prepare("PRAGMA table_info(forecast_intraday_run_audit)").all();
  for (const name of [
    "algorithm_version",
    "base_run_audit_id",
    "series_run_id",
    "output_updated_ts",
    "authoritative_algorithm",
    "challenger_status",
    "authoritative_write_status",
    "configured_mode",
    "prior_series_preserved",
  ]) {
    assert(columns.some((column) => column.name === name), `missing audit column ${name}`);
  }
  const intradayColumns = db.prepare("PRAGMA table_info(forecast_intraday_adjusted)").all();
  assert(intradayColumns.some((column) => column.name === "series_run_id"));
  const immutableColumns = db.prepare("PRAGMA table_info(forecast_dayahead_immutable)").all();
  for (const name of ["date", "issuance_id", "generated_ts", "slot", "time_hms", "kwh_inc", "kwh_lo", "kwh_hi", "source"]) {
    assert(immutableColumns.some((column) => column.name === name), `missing immutable column ${name}`);
  }
  const issuanceColumns = db.prepare("PRAGMA table_info(forecast_dayahead_issuance)").all();
  for (const name of ["basis_checksum", "weather_snapshot_sha256", "constraint_snapshot_sha256", "model_sha256", "artifact_sha256", "base_run_audit_id"]) {
    assert(issuanceColumns.some((column) => column.name === name), `missing issuance column ${name}`);
  }
  const indexes = db.prepare("PRAGMA index_list(forecast_intraday_run_audit)").all();
  assert(indexes.some((index) => index.name === "idx_fira_date_ts"));
  const insert = db.prepare(`
    INSERT INTO forecast_intraday_run_audit
      (target_date, generated_ts, cutoff_slot, algorithm_version, execution_mode)
    VALUES (?, ?, ?, ?, ?)
  `);
  const now = Date.now();
  insert.run("2026-05-01", now - 31 * 86400000, 100, "robust_decay_v1", "shadow");
  insert.run("2026-05-02", now - 29 * 86400000, 100, "robust_decay_v1", "shadow");
  const result = stmts.pruneForecastIntradayRunAuditBeforeTs.run(now - 30 * 86400000);
  assert.equal(result.changes, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM forecast_intraday_run_audit").get().n, 1);

  const intradayRows = [60, 61].map((slot) => ({
    ts: new Date(`2026-05-03T${slot === 60 ? "05:00" : "05:05"}:00`).getTime(),
    slot,
    time_hms: slot === 60 ? "05:00:00" : "05:05:00",
    kwh_inc: 10,
    kwh_lo: 8,
    kwh_hi: 12,
    series_run_id: "IR-current",
  }));
  bulkUpsertForecastIntradayAdjusted("2026-05-03", intradayRows, "test");
  assert.deepEqual(
    db.prepare("SELECT DISTINCT series_run_id FROM forecast_intraday_adjusted WHERE date=?").all("2026-05-03"),
    [{ series_run_id: "IR-current" }],
  );

  const immutableRows = Array.from({ length: 156 }, (_, index) => {
    const slot = 60 + index;
    const minutes = slot * 5;
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return {
      ts: new Date(`2026-05-04T${hh}:${mm}:00`).getTime(),
      slot,
      time_hms: `${hh}:${mm}:00`,
      kwh_inc: 10 + index / 10,
      kwh_lo: 9 + index / 10,
      kwh_hi: 11 + index / 10,
    };
  });
  bulkUpsertForecastDayAhead("2026-05-04", immutableRows, "context-sync");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead_immutable WHERE date=?").get("2026-05-04").n,
    0,
    "generic context sync must not fabricate immutable issuance history",
  );
  const basisText = immutableRows
    .map((row) => `${row.slot}|${row.time_hms}|${row.kwh_inc.toFixed(9)}|${row.kwh_lo.toFixed(9)}|${row.kwh_hi.toFixed(9)}`)
    .join("\n");
  const basisChecksum = crypto.createHash("sha256").update(basisText, "utf8").digest("hex");
  const weatherJson = JSON.stringify({
    day: "2026-05-04",
    applied_hourly: [{ time: "2026-05-04T05:00:00+08:00", rad: 0, cloud: 10 }],
  });
  const weatherSha = crypto.createHash("sha256").update(weatherJson, "utf8").digest("hex");
  const constraintJson = JSON.stringify({
    slot_cap_kwh: 1000,
    nowcast_config: { forecastIntradayBlendMax: 0.72 },
    cap_dispatch_mask: Array(288).fill(0),
    outage_mask: Array(288).fill(0),
  });
  const constraintSha = crypto.createHash("sha256").update(constraintJson, "utf8").digest("hex");
  bulkUpsertForecastDayAhead("2026-05-04", immutableRows, "test", {
    issuance_id: "DI-test-1",
    date: "2026-05-04",
    generated_ts: 1777842000000,
    source: "test",
    expected_slot_count: 156,
    basis_checksum: basisChecksum,
    weather_snapshot_json: weatherJson,
    weather_snapshot_sha256: weatherSha,
    constraint_snapshot_json: constraintJson,
    constraint_snapshot_sha256: constraintSha,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead_immutable WHERE issuance_id=?").get("DI-test-1").n, 156);

  const missingConstraintWeather = JSON.stringify({
    day: "2026-05-08",
    applied_hourly: [{ time: "2026-05-08T05:00:00+08:00", rad: 0, cloud: 10 }],
  });
  assert.throws(() => {
    bulkUpsertForecastDayAhead("2026-05-08", immutableRows, "test", {
      issuance_id: "DI-test-no-constraints",
      date: "2026-05-08",
      generated_ts: 1778187600000,
      expected_slot_count: 156,
      basis_checksum: basisChecksum,
      weather_snapshot_json: missingConstraintWeather,
      weather_snapshot_sha256: crypto.createHash("sha256")
        .update(missingConstraintWeather, "utf8")
        .digest("hex"),
    });
  }, /constraint snapshot checksum/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead WHERE date=?").get("2026-05-08").n,
    0,
    "an issuance without causal constraints must roll back the mutable replacement",
  );

  const beforeInvalid = db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead WHERE date=?").get("2026-05-05").n;
  assert.throws(() => {
    bulkUpsertForecastDayAhead("2026-05-05", immutableRows.map((row) => ({ ...row })), "test", {
      issuance_id: "DI-test-invalid",
      date: "2026-05-05",
      generated_ts: 1777928400000,
      expected_slot_count: 156,
      basis_checksum: "0".repeat(64),
      weather_snapshot_json: weatherJson,
      weather_snapshot_sha256: weatherSha,
    });
  }, /checksum/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead WHERE date=?").get("2026-05-05").n,
    beforeInvalid,
    "failed issuance validation must roll back the mutable replacement",
  );
  const duplicateSlotRows = immutableRows.map((row) => ({ ...row }));
  duplicateSlotRows[duplicateSlotRows.length - 1] = { ...duplicateSlotRows[0] };
  assert.throws(() => {
    bulkUpsertForecastDayAhead("2026-05-06", duplicateSlotRows, "test", {
      issuance_id: "DI-test-duplicate",
      date: "2026-05-06",
      generated_ts: 1778014800000,
      expected_slot_count: 156,
      basis_checksum: basisChecksum,
      weather_snapshot_json: weatherJson,
      weather_snapshot_sha256: weatherSha,
    });
  }, /slot batch/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead WHERE date=?").get("2026-05-06").n, 0);
  const invalidBandRows = immutableRows.map((row) => ({ ...row }));
  invalidBandRows[0].kwh_lo = invalidBandRows[0].kwh_inc + 1;
  assert.throws(() => {
    bulkUpsertForecastDayAhead("2026-05-07", invalidBandRows, "test", {
      issuance_id: "DI-test-band",
      date: "2026-05-07",
      generated_ts: 1778101200000,
      expected_slot_count: 156,
      basis_checksum: basisChecksum,
      weather_snapshot_json: weatherJson,
      weather_snapshot_sha256: weatherSha,
    });
  }, /slot batch/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead WHERE date=?").get("2026-05-07").n, 0);
  closeDb();

  // A second startup against the migrated database must be idempotent and keep
  // both schema and provenance rows intact before statements are prepared.
  delete require.cache[require.resolve(dbModulePath)];
  const reopened = require(dbModulePath);
  const reopenedIntradayColumns = reopened.db.prepare("PRAGMA table_info(forecast_intraday_adjusted)").all();
  assert(reopenedIntradayColumns.some((column) => column.name === "series_run_id"));
  assert.equal(
    reopened.db.prepare("SELECT COUNT(*) AS n FROM forecast_dayahead_immutable WHERE issuance_id=?").get("DI-test-1").n,
    156,
  );
  assert.deepEqual(
    reopened.db.prepare("SELECT DISTINCT series_run_id FROM forecast_intraday_adjusted WHERE date=?").all("2026-05-03"),
    [{ series_run_id: "IR-current" }],
  );
  reopened.closeDb();
} finally {
  if (previousDataDir === undefined) delete process.env.ADSI_DATA_DIR;
  else process.env.ADSI_DATA_DIR = previousDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
}

const legacyTmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsi-nowcast-legacy-"));
try {
  const child = childProcess.spawnSync(process.execPath, [__filename, "--legacy-child"], {
    cwd: root,
    env: { ...process.env, ADSI_DATA_DIR: legacyTmp, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || "1" },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout || "legacy migration child failed");
} finally {
  fs.rmSync(legacyTmp, { recursive: true, force: true });
}

console.log("forecastIntradayAudit.test.js: PASS");
