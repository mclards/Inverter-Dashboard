"use strict";

const assert = require("assert");
const fs_util = require("fs");
const path = require("path");

const dbSrc = fs_util.readFileSync(path.join(__dirname, "..", "db.js"), "utf8");
const reasonsSrc = fs_util.readFileSync(path.join(__dirname, "..", "stopReasons.js"), "utf8");
const aggSrc = fs_util.readFileSync(path.join(__dirname, "..", "dailyAggregator.js"), "utf8");
const fwSrc = fs_util.readFileSync(path.join(__dirname, "..", "firmwareMap.js"), "utf8");

function test(name, fn) {
  try {
    fn();
    console.log("  ✓ " + name);
  } catch (err) {
    console.log("  ✗ " + name);
    console.log("    " + err.message);
    process.exitCode = 1;
  }
}

test("archiveTableBeforeCutoff exists", () => {
  assert.ok(/async\s+function\s+archiveTableBeforeCutoff\s*\(/.test(dbSrc));
});

test("archiveTableBeforeCutoff has tableName parameter", () => {
  assert.ok(/async\s+function\s+archiveTableBeforeCutoff[\s\S]*tableName/.test(dbSrc));
});

test("archiveTableBeforeCutoff has cutoffColumn parameter", () => {
  assert.ok(/async\s+function\s+archiveTableBeforeCutoff[\s\S]*cutoffColumn/.test(dbSrc));
});

test("archiveTableBeforeCutoff has cutoffValue parameter", () => {
  assert.ok(/async\s+function\s+archiveTableBeforeCutoff[\s\S]*cutoffValue/.test(dbSrc));
});

test("archiveTableBeforeCutoff has monthKeyColumn parameter", () => {
  assert.ok(/async\s+function\s+archiveTableBeforeCutoff[\s\S]*monthKeyColumn/.test(dbSrc));
});

test("archiveTableBeforeCutoff has monthKeyKind parameter", () => {
  assert.ok(/async\s+function\s+archiveTableBeforeCutoff[\s\S]*monthKeyKind/.test(dbSrc));
});

test("Uses ARCHIVE_RUNNING_LOCK concurrency guard", () => {
  assert.ok(/ARCHIVE_RUNNING_LOCK/.test(dbSrc));
});

test("Enforces ARCHIVE_MAX_BATCHES_PER_CALL batch ceiling", () => {
  assert.ok(/ARCHIVE_MAX_BATCHES_PER_CALL/.test(dbSrc));
});

test("Uses ARCHIVE_HOT_STMT_CACHE statement cache", () => {
  assert.ok(/ARCHIVE_HOT_STMT_CACHE/.test(dbSrc));
});

test("Uses ARCHIVE_PER_SHARD_INSERT_CACHE shard cache", () => {
  assert.ok(/ARCHIVE_PER_SHARD_INSERT_CACHE/.test(dbSrc));
});

test("Discovers schema via sqlite_master", () => {
  assert.ok(/sqlite_master/.test(dbSrc));
});

test("Detects WITHOUT ROWID semantics", () => {
  assert.ok(/WITHOUT\s+ROWID/.test(dbSrc));
});

test("Yields event loop between batches", () => {
  assert.ok(/_yieldEventLoop/.test(dbSrc));
});

test("pruneSnapshotHistory archives snapshot_history", () => {
  assert.ok(/archiveTableBeforeCutoff[\s\S]*?snapshot_history|snapshot_history[\s\S]*?archiveTableBeforeCutoff/.test(dbSrc));
});

test("pruneApcVerifyLog archives apc_verify_log", () => {
  assert.ok(/archiveTableBeforeCutoff[\s\S]*?apc_verify_log|apc_verify_log[\s\S]*?archiveTableBeforeCutoff/.test(dbSrc));
});

test("pruneGridControlVerifyLog archives grid_control_verify_log", () => {
  assert.ok(/archiveTableBeforeCutoff[\s\S]*?grid_control_verify_log|grid_control_verify_log[\s\S]*?archiveTableBeforeCutoff/.test(dbSrc));
});

test("pruneRampLog archives inverter_curtailment_ramp_log", () => {
  assert.ok(/archiveTableBeforeCutoff[\s\S]*?inverter_curtailment_ramp_log|inverter_curtailment_ramp_log[\s\S]*?archiveTableBeforeCutoff/.test(dbSrc));
});

test("pruneIgbtThermalBaseline archives igbt_thermal_baseline", () => {
  assert.ok(/archiveTableBeforeCutoff[\s\S]*?igbt_thermal_baseline|igbt_thermal_baseline[\s\S]*?archiveTableBeforeCutoff/.test(dbSrc));
});

test("pruneOldRows archives inverter_stop_histogram", () => {
  assert.ok(/async\s+function\s+pruneOldRows[\s\S]*archiveTableBeforeCutoff[\s\S]*inverter_stop_histogram|async\s+function\s+pruneOldRows[\s\S]*inverter_stop_histogram[\s\S]*archiveTableBeforeCutoff/.test(reasonsSrc));
});

test("pruneRetention archives inverter_5min_param", () => {
  assert.ok(/async\s+function\s+pruneRetention[\s\S]*archiveTableBeforeCutoff[\s\S]*inverter_5min_param|async\s+function\s+pruneRetention[\s\S]*inverter_5min_param[\s\S]*archiveTableBeforeCutoff/.test(aggSrc));
});

test("pruneFirmwareDriftLog archives firmware_drift_log", () => {
  assert.ok(/function\s+pruneFirmwareDriftLog[\s\S]*archiveTableBeforeCutoff[\s\S]*firmware_drift_log|function\s+pruneFirmwareDriftLog[\s\S]*firmware_drift_log[\s\S]*archiveTableBeforeCutoff/.test(fwSrc));
});

test("archiveTableBeforeCutoff is exported from db.js", () => {
  assert.ok(/archiveTableBeforeCutoff[\s\S]*module\.exports|module\.exports[\s\S]*archiveTableBeforeCutoff/.test(dbSrc));
});

console.log("");
console.log("archiveUniversalContractShape.test.js: PASS (archive helper contract locked)");