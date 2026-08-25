"use strict";

// ABI-agnostic shape test for the inverter_stop_reasons archive contract
// added in v2.11.1-beta.1. Parses server/db.js + server/stopReasons.js +
// server/index.js as text (no better-sqlite3 load), locking the wiring
// that keeps the alarm-drilldown's "Captured at the moment of the alarm"
// panel populated indefinitely — even after the joined alarm row has
// migrated to its own monthly archive shard.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dbSrc          = fs.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
const stopReasonsSrc = fs.readFileSync(path.join(__dirname, "..", "stopReasons.js"), "utf8");
const indexSrc       = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

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
test("archive schema declares an inverter_stop_reasons DDL", () => {
  assert.ok(
    /const ARCHIVE_STOP_REASONS_TABLE_DDL\s*=\s*`[\s\S]*id\s+INTEGER PRIMARY KEY/.test(dbSrc),
    "ARCHIVE_STOP_REASONS_TABLE_DDL must exist with `id INTEGER PRIMARY KEY` (no AUTOINCREMENT — hot id preserved)",
  );
  assert.ok(
    /AUTOINCREMENT/.test(
      dbSrc.match(/const ARCHIVE_STOP_REASONS_TABLE_DDL[\s\S]*?`;/)[0],
    ) === false,
    "archive stop_reasons MUST NOT use AUTOINCREMENT — hot id must be preserved so cross-tier dedup works",
  );
});

test("ensureArchiveSchema creates inverter_stop_reasons table on every shard", () => {
  const block = dbSrc.match(/function ensureArchiveSchema[\s\S]*?\n\}/)[0];
  assert.ok(
    /CREATE TABLE IF NOT EXISTS inverter_stop_reasons/.test(block),
    "ensureArchiveSchema must CREATE TABLE IF NOT EXISTS inverter_stop_reasons",
  );
  assert.ok(
    /CREATE INDEX IF NOT EXISTS idx_asr_read_at\b/.test(block) &&
      /CREATE INDEX IF NOT EXISTS idx_asr_alarm_id\b/.test(block),
    "ensureArchiveSchema must create idx_asr_read_at AND idx_asr_alarm_id on the archive stop_reasons table",
  );
});

test("archive entry exposes insertStopReason + per-id + per-alarm-id stmts", () => {
  const block = dbSrc.match(/function createArchiveEntry[\s\S]*?return entry;\n\}/)[0];
  for (const stmt of [
    "insertStopReason",
    "selectStopReasonById",
    "selectStopReasonsByAlarmId",
    "insertStopReasonsTx",
  ]) {
    assert.ok(
      new RegExp(`(entry\\.)?${stmt}`).test(block),
      `createArchiveEntry must expose ${stmt}`,
    );
  }
  assert.ok(
    /INSERT OR IGNORE INTO inverter_stop_reasons/.test(block),
    "archive stop_reasons insert must use INSERT OR IGNORE so re-runs are idempotent",
  );
});

// ─── Write path ────────────────────────────────────────────────────────────
test("retention worker now ARCHIVES stop_reasons (not DELETE'd)", () => {
  // Pre-v2.11.1-beta.1 bug: stopReasons.pruneOldRows ran
  //   db.prepare("DELETE FROM inverter_stop_reasons WHERE read_at_ms < ?")
  // unconditionally. Now the archive worker is injected from the caller.
  const pruneBlock = stopReasonsSrc.match(/function pruneOldRows[\s\S]*?\n\}/)[0];
  assert.ok(
    /archiveStopReasonsBeforeCutoff/.test(pruneBlock),
    "stopReasons.pruneOldRows must accept + call archiveStopReasonsBeforeCutoff (replaces the legacy DELETE)",
  );
  // The histogram table stays DELETE-only (regenerable from inverter on
  // demand) — that's expected, so we don't assert the DELETE is gone.
  assert.ok(
    /async function pruneOldRows/.test(stopReasonsSrc),
    "pruneOldRows must be async — archive worker is async",
  );

  // Archive worker must exist in db.js.
  assert.ok(
    /async function archiveStopReasonsBeforeCutoff/.test(dbSrc),
    "archiveStopReasonsBeforeCutoff worker function must exist in db.js",
  );
  const workerBlock = dbSrc.match(/async function archiveStopReasonsBeforeCutoff[\s\S]*?\n\}/)[0];
  assert.ok(
    /selectOldStopReasonsBatch\.all\(cutoff, ARCHIVE_BATCH_SIZE\)/.test(workerBlock),
    "archiveStopReasonsBeforeCutoff must drain selectOldStopReasonsBatch in batches",
  );
  assert.ok(
    /archiveRowsByMonth\(rows,\s*["']stop_reasons["']\)/.test(workerBlock),
    "archiveStopReasonsBeforeCutoff must call archiveRowsByMonth(rows, 'stop_reasons')",
  );
  assert.ok(
    /deleteStopReasonsBatchTx/.test(workerBlock),
    "archiveStopReasonsBeforeCutoff must delete archived rows from hot via deleteStopReasonsBatchTx",
  );
});

test("archiveRowsByMonth dispatches the stop_reasons type with read_at_ms month key", () => {
  const block = dbSrc.match(/function archiveRowsByMonth[\s\S]*?\n\}/)[0];
  assert.ok(
    /type === ["']stop_reasons["'][\s\S]*insertStopReasonsTx/.test(block),
    "archiveRowsByMonth must route type='stop_reasons' to entry.insertStopReasonsTx",
  );
  // stop_reasons uses read_at_ms (not ts) for the time column. Make sure
  // the month-key extractor branches on type so shards stay correct.
  assert.ok(
    /type === ["']stop_reasons["'][\s\S]*monthKeyFromTs\(row\?\.read_at_ms\)/.test(block),
    "archiveRowsByMonth must group stop_reasons rows by month-key from read_at_ms (not ts)",
  );
});

test("selectOldStopReasonsBatch filters on read_at_ms (not ts)", () => {
  assert.ok(
    /selectOldStopReasonsBatch\s*=\s*db\.prepare\(`[\s\S]*FROM inverter_stop_reasons[\s\S]*WHERE read_at_ms < \?/.test(dbSrc),
    "selectOldStopReasonsBatch must filter `read_at_ms < ?` — stop_reasons doesn't have a ts column",
  );
});

// ─── Read path (archive-aware fallback) ───────────────────────────────────
test("findStopReasonByIdArchiveAware checks hot then iterates archives", () => {
  const block = dbSrc.match(/function findStopReasonByIdArchiveAware[\s\S]*?\n\}/)[0];
  assert.ok(/FROM inverter_stop_reasons WHERE id = \?/.test(block));
  assert.ok(/getArchiveEntry\(monthKey,\s*false\)/.test(block));
  assert.ok(/\.reverse\(\)/.test(block), "should iterate archives newest-first for typical drilldown locality");
});

test("findStopReasonByAlarmIdArchiveAware checks hot then iterates archives", () => {
  const block = dbSrc.match(/function findStopReasonByAlarmIdArchiveAware[\s\S]*?\n\}/)[0];
  assert.ok(/WHERE alarm_id = \?/.test(block));
  assert.ok(/getArchiveEntry\(monthKey,\s*false\)/.test(block));
  assert.ok(/selectStopReasonsByAlarmId/.test(block));
});

test("stopReasons.getEventById accepts archiveLookup fallback", () => {
  const block = stopReasonsSrc.match(/function getEventById[\s\S]*?\n\}/)[0];
  assert.ok(
    /archiveLookup/.test(block),
    "getEventById must accept an archiveLookup function so a row in archives still surfaces decorated",
  );
});

test("stopReasons.getEventByAlarmId accepts archiveLookup fallback", () => {
  const block = stopReasonsSrc.match(/function getEventByAlarmId[\s\S]*?\n\}/)[0];
  assert.ok(
    /archiveLookup/.test(block),
    "getEventByAlarmId must accept an archiveLookup function",
  );
});

// ─── Wire-up ───────────────────────────────────────────────────────────────
test("alarm drilldown wires both archive-aware stop_reason finders", () => {
  const block = indexSrc.match(/app\.get\(["']\/api\/alarms\/:alarm_id\/stop-reason["'][\s\S]*?\n\}\);/)[0];
  assert.ok(
    /findStopReasonByIdArchiveAware/.test(block),
    "drilldown endpoint must pass findStopReasonByIdArchiveAware as archiveLookup",
  );
  assert.ok(
    /findStopReasonByAlarmIdArchiveAware/.test(block),
    "drilldown endpoint must pass findStopReasonByAlarmIdArchiveAware as the by-alarm archiveLookup",
  );
});

test("stop_reasons cron caller injects archive worker", () => {
  const block = indexSrc.match(/async function _prunStopReasonRetention[\s\S]*?\n\}/)[0];
  assert.ok(
    /archiveStopReasonsBeforeCutoff/.test(block),
    "_prunStopReasonRetention must pass archiveStopReasonsBeforeCutoff into stopReasons.pruneOldRows",
  );
  assert.ok(
    /await stopReasons\.pruneOldRows/.test(block),
    "_prunStopReasonRetention must await pruneOldRows (now async due to archive worker)",
  );
});

test("module.exports surfaces the new archive helpers", () => {
  const tail = dbSrc.split("module.exports")[1] || "";
  assert.ok(/findStopReasonByIdArchiveAware/.test(tail));
  assert.ok(/findStopReasonByAlarmIdArchiveAware/.test(tail));
  assert.ok(/archiveStopReasonsBeforeCutoff/.test(tail));
});

console.log(
  "stopReasonsArchiveContractShape.test.js: PASS (schema + write-path + read-path + drilldown wire-up locked)",
);
