"use strict";

// ABI-agnostic shape test for the alarm-archive contract added in
// v2.11.0-beta.10. Parses server/db.js + server/index.js + server/exporter.js
// as TEXT (no better-sqlite3 load), locking the wiring that prevents the
// "can't access alarms beyond May 20" regression from recurring after a
// retainDays-driven prune.
//
// Companion to alarmArchiveRoundtripCore.test.js (which exercises the
// actual write/migrate/read flow under Node-ABI).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dbSrc       = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
const indexSrc    = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const exporterSrc = fs.readFileSync(path.join(__dirname, "..", "exporter.js"), "utf8");

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    process.stdout.write(`  ✗ ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
    throw err;
  }
}

// ─── Schema ────────────────────────────────────────────────────────────────
test("archive schema declares an alarms table DDL", () => {
  assert.ok(
    /const ARCHIVE_ALARM_TABLE_DDL\s*=\s*`[\s\S]*id\s+INTEGER PRIMARY KEY/.test(dbSrc),
    "ARCHIVE_ALARM_TABLE_DDL constant must exist with id INTEGER PRIMARY KEY (no AUTOINCREMENT so hot ids migrate intact)",
  );
  assert.ok(
    /AUTOINCREMENT/.test(
      dbSrc.match(/const ARCHIVE_ALARM_TABLE_DDL[\s\S]*?`;/)[0],
    ) === false,
    "archive alarms table MUST NOT use AUTOINCREMENT — hot id must be preserved so dedup by id is stable",
  );
});

test("ensureArchiveSchema creates alarms table on every shard", () => {
  const block = dbSrc.match(/function ensureArchiveSchema[\s\S]*?\n\}/)[0];
  assert.ok(
    /CREATE TABLE IF NOT EXISTS alarms/.test(block),
    "ensureArchiveSchema must CREATE TABLE IF NOT EXISTS alarms",
  );
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_aa_ts/.test(block) &&
      /CREATE INDEX IF NOT EXISTS idx_aa_inv_ts/.test(block),
    "ensureArchiveSchema must create idx_aa_ts AND idx_aa_inv_ts on the archive alarms table",
  );
});

test("createArchiveEntry always runs ensureArchiveSchema (covers pre-existing shards)", () => {
  const block = dbSrc.match(/function createArchiveEntry[\s\S]*?\n\}/)[0];
  // Must call ensureArchiveSchema unconditionally so old archive DBs that
  // pre-date the alarms shard gain it on first reopen.
  const calls = (block.match(/ensureArchiveSchema\(archiveDb\)/g) || []).length;
  assert.ok(
    calls >= 1 && !/if\s*\(\s*!existed\s*\)[\s\S]{0,80}ensureArchiveSchema/.test(block),
    "ensureArchiveSchema must be called unconditionally (no `if (!existed)` gate) so older archive DBs get the alarms table on reopen",
  );
});

test("archive entry exposes alarm insert + range statements", () => {
  const block = dbSrc.match(/function createArchiveEntry[\s\S]*?return entry;\n\}/)[0];
  for (const stmt of ["insertAlarm", "selectAlarmsRangeAll", "selectAlarmsRangeByInv", "insertAlarmsTx"]) {
    assert.ok(
      new RegExp(`(entry\\.)?${stmt}`).test(block),
      `createArchiveEntry must expose ${stmt}`,
    );
  }
  assert.ok(
    /INSERT OR IGNORE INTO alarms/.test(block),
    "archive alarm insert must use INSERT OR IGNORE so re-runs are idempotent",
  );
});

// ─── Write path ────────────────────────────────────────────────────────────
test("pruner now ARCHIVES alarms instead of permanently deleting them", () => {
  // The pre-v2.11.0-beta.10 bug: pruneOldData ran
  //   DELETE FROM alarms WHERE ts < ? AND cleared_ts IS NOT NULL
  // unconditionally. That MUST NOT exist anymore.
  const pruneBlock = dbSrc.match(/async function pruneOldData[\s\S]*?\n\}\s*\n/)[0];
  assert.ok(
    !/db\.prepare\(\s*["']DELETE FROM alarms[^)]*\)\.run\(cutoff\)/.test(pruneBlock),
    "REGRESSION: pruneOldData() still contains the unconditional `DELETE FROM alarms` — this caused the 2026-05-22 'can't access past alarms' incident. The selector + archive loop must own the migration.",
  );

  // The new selector + archive loop must be present.
  assert.ok(
    /selectOldAlarmsBatch\s*=\s*db\.prepare\(/.test(dbSrc),
    "selectOldAlarmsBatch prepared statement missing",
  );
  assert.ok(
    /WHERE ts < \?\s+AND cleared_ts IS NOT NULL/.test(dbSrc),
    "selectOldAlarmsBatch must filter cleared_ts IS NOT NULL — active alarms must never be migrated out of hot",
  );

  // archiveTelemetryBeforeCutoff must include the alarms loop.
  const archBlock = dbSrc.match(/async function archiveTelemetryBeforeCutoff[\s\S]*?\n\}/)[0];
  assert.ok(
    /selectOldAlarmsBatch\.all\(cutoff, ARCHIVE_BATCH_SIZE\)/.test(archBlock),
    "archiveTelemetryBeforeCutoff must drain selectOldAlarmsBatch in batches",
  );
  assert.ok(
    /archiveRowsByMonth\(rows,\s*["']alarms["']\)/.test(archBlock),
    "archiveTelemetryBeforeCutoff must call archiveRowsByMonth(rows, 'alarms')",
  );
  assert.ok(
    /deleteAlarmsBatchTx/.test(archBlock),
    "archiveTelemetryBeforeCutoff must delete archived rows from hot via deleteAlarmsBatchTx",
  );
  assert.ok(
    /stats\.alarms/.test(archBlock),
    "archiveTelemetryBeforeCutoff stats must include `alarms` counter for audit visibility",
  );
});

test("archiveRowsByMonth dispatches the alarms type", () => {
  const block = dbSrc.match(/function archiveRowsByMonth[\s\S]*?\n\}/)[0];
  assert.ok(
    /type === ["']alarms["'][\s\S]*insertAlarmsTx/.test(block),
    "archiveRowsByMonth must route type='alarms' to entry.insertAlarmsTx",
  );
});

// ─── Read path ─────────────────────────────────────────────────────────────
test("queryAlarmsRangeArchiveAware merges hot + archive shards", () => {
  const block = dbSrc.match(/function queryAlarmsRangeArchiveAware[\s\S]*?\n\}/)[0];
  assert.ok(
    /iterateMonthKeys\s*\(/.test(block),
    "archive-aware reader must iterate month keys across [s,e]",
  );
  assert.ok(
    /getArchiveEntry\(monthKey,\s*false\)/.test(block),
    "archive-aware reader must use getArchiveEntry(key, false) — LRU stays authoritative; no raw archive opens",
  );
  assert.ok(
    /sortAlarmsDesc/.test(block),
    "archive-aware reader must sort ts DESC to match the alarm-log UI contract",
  );
  assert.ok(
    /\.slice\(0,\s*cap\)/.test(block),
    "archive-aware reader must apply LIMIT after merge (sort then slice) so old + new co-exist within the cap",
  );
});

test("findAlarmByIdArchiveAware checks hot then iterates archives", () => {
  const block = dbSrc.match(/function findAlarmByIdArchiveAware[\s\S]*?\n\}/)[0];
  assert.ok(/SELECT[\s\S]+FROM alarms WHERE id = \?/.test(block));
  assert.ok(/getArchiveEntry\(monthKey,\s*false\)/.test(block));
  assert.ok(/\.reverse\(\)/.test(block), "should iterate archives newest-first for typical drilldown locality");
});

test("module.exports surfaces the new helpers", () => {
  assert.ok(/queryAlarmsRangeArchiveAware/.test(dbSrc.split("module.exports")[1] || ""));
  assert.ok(/findAlarmByIdArchiveAware/.test(dbSrc.split("module.exports")[1] || ""));
});

// ─── Wire-up: index.js + exporter.js ──────────────────────────────────────
test("/api/alarms uses the archive-aware reader", () => {
  const block = indexSrc.match(/app\.get\(["']\/api\/alarms["'][\s\S]*?\n\}\);/)[0];
  assert.ok(
    /queryAlarmsRangeArchiveAware\(/.test(block),
    "/api/alarms must call queryAlarmsRangeArchiveAware so past-date queries surface archived rows",
  );
  // Must NOT use the old hot-only prepare path.
  assert.ok(
    !/stmts\.getAlarmsRange\.all\(/.test(block),
    "/api/alarms must NOT still call stmts.getAlarmsRange.all — that's the hot-only path the archive-aware reader replaces",
  );
});

test("/api/alarms/:alarm_id/stop-reason uses archive-aware single-id lookup", () => {
  const block = indexSrc.match(/app\.get\(["']\/api\/alarms\/:alarm_id\/stop-reason["'][\s\S]*?\n\}\);/)[0];
  assert.ok(
    /findAlarmByIdArchiveAware\(/.test(block),
    "drilldown endpoint must use findAlarmByIdArchiveAware so click-through on an archived alarm row still resolves",
  );
});

test("exportAlarms uses archive-aware reader for past-month exports", () => {
  const block = exporterSrc.match(/async function exportAlarms[\s\S]*?\n\}/)[0];
  assert.ok(
    /queryAlarmsRangeArchiveAware\(/.test(block),
    "exportAlarms must use queryAlarmsRangeArchiveAware so past-month CSV exports include archived rows",
  );
  assert.ok(
    !/db\.prepare\(`SELECT[\s\S]*FROM alarms WHERE/.test(block),
    "exportAlarms must NOT still use the hot-only db.prepare(... FROM alarms ...) path",
  );
});

console.log(
  "alarmArchiveContractShape.test.js: PASS (schema + write-path + read-path + wire-up locked)",
);
