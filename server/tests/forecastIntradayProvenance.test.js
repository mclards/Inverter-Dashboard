"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "adsi-nowcast-provenance-"),
);
process.env.ADSI_SERVER_PORT = process.env.ADSI_SERVER_PORT || "3547";
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), { recursive: true });

const baseUrl = `http://127.0.0.1:${Number(process.env.ADSI_SERVER_PORT)}`;
const dbModule = require("../db.js");
const serverModule = require("../index.js");
const { db, stmts } = dbModule;

const insertIntradayRow = db.prepare(`
  INSERT OR REPLACE INTO forecast_intraday_adjusted(
    date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi,
    source, updated_ts, series_run_id
  ) VALUES(?, ?, ?, ?, ?, ?, ?, 'test', ?, ?)
`);
const insertDayAheadRow = db.prepare(`
  INSERT OR REPLACE INTO forecast_dayahead(
    date, ts, slot, time_hms, kwh_inc, kwh_lo, kwh_hi, source, updated_ts
  ) VALUES(?, ?, ?, ?, ?, ?, ?, 'test', ?)
`);
const insertAudit = db.prepare(`
  INSERT OR REPLACE INTO forecast_intraday_run_audit(
    target_date, generated_ts, cutoff_slot, algorithm_version, execution_mode,
    eligible_slots, strength, run_status, notes_json, series_run_id,
    output_updated_ts, authoritative_algorithm, challenger_status,
    authoritative_write_status, configured_mode, prior_series_preserved
  ) VALUES(
    @target_date, @generated_ts, @cutoff_slot, @algorithm_version, @execution_mode,
    @eligible_slots, @strength, @run_status, @notes_json, @series_run_id,
    @output_updated_ts, @authoritative_algorithm, @challenger_status,
    @authoritative_write_status, @configured_mode, @prior_series_preserved
  )
`);

function dayTs(day, slot) {
  return new Date(`${day}T00:00:00`).getTime() + Number(slot) * 300000;
}

function addIntradayBatch(day, runIds, updatedTs) {
  [60, 61].forEach((slot, index) => {
    const runId = Array.isArray(runIds) ? runIds[index] : runIds;
    insertIntradayRow.run(
      day,
      dayTs(day, slot),
      slot,
      slot === 60 ? "05:00:00" : "05:05:00",
      10 + index,
      8 + index,
      12 + index,
      updatedTs,
      runId,
    );
  });
}

function addDayAheadBatch(day, updatedTs) {
  [60, 61].forEach((slot, index) => {
    insertDayAheadRow.run(
      day,
      dayTs(day, slot),
      slot,
      slot === 60 ? "05:00:00" : "05:05:00",
      10 + index,
      8 + index,
      12 + index,
      updatedTs,
    );
  });
}

function addAudit(overrides) {
  const generatedTs = Number(overrides.generated_ts);
  insertAudit.run({
    target_date: overrides.target_date,
    generated_ts: generatedTs,
    cutoff_slot: overrides.cutoff_slot ?? 90,
    algorithm_version: overrides.algorithm_version || "robust_decay_v1",
    execution_mode: overrides.execution_mode || "active",
    eligible_slots: overrides.eligible_slots ?? 21,
    strength: overrides.strength ?? 0.5,
    run_status: overrides.run_status || "success",
    notes_json: JSON.stringify(overrides.notes || {}),
    series_run_id: overrides.series_run_id || null,
    output_updated_ts: overrides.output_updated_ts || generatedTs,
    authoritative_algorithm: overrides.authoritative_algorithm || "current_ratio_v1",
    challenger_status: overrides.challenger_status || null,
    authoritative_write_status: overrides.authoritative_write_status || "success",
    configured_mode: overrides.configured_mode || overrides.execution_mode || "off",
    prior_series_preserved: overrides.prior_series_preserved ? 1 : 0,
  });
}

async function getChart(day) {
  const response = await fetch(`${baseUrl}/api/analytics/dayahead-chart?date=${day}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  return body;
}

async function run() {
  try {
    await new Promise((resolve) => setTimeout(resolve, 900));
    stmts.setSetting.run("forecastVirtualNowcastMode", "off", Date.now());

    // Exact id wins over both an older successful robust run and a newer failed
    // attempt. The failed attempt remains available only as latest diagnostics.
    const dayOff = "2026-07-01";
    addIntradayBatch(dayOff, "IR-off-current", 2000);
    addAudit({
      target_date: dayOff,
      generated_ts: 1000,
      series_run_id: "IR-old-robust",
      authoritative_algorithm: "robust_decay_v1",
      configured_mode: "active",
      challenger_status: "success",
    });
    addAudit({
      target_date: dayOff,
      generated_ts: 2000,
      series_run_id: "IR-off-current",
      execution_mode: "off",
      configured_mode: "off",
      algorithm_version: "current_ratio_v1",
      authoritative_algorithm: "current_ratio_v1",
      challenger_status: "not_run",
    });
    addAudit({
      target_date: dayOff,
      generated_ts: 3000,
      series_run_id: "IR-failed-attempt",
      run_status: "write_failed",
      authoritative_write_status: "failed",
      prior_series_preserved: true,
      notes: { fallback_reason: "series_write_failed" },
    });
    let chart = await getChart(dayOff);
    assert.equal(chart.ml_final.meta.series_run_id, "IR-off-current", JSON.stringify(chart.ml_final.meta));
    assert.equal(chart.ml_final.meta.series_algorithm, "current_ratio_v1");
    assert.equal(chart.ml_final.meta.configured_mode, "off");
    assert.equal(chart.ml_final.meta.provenance_status, "matched");
    assert.equal(chart.ml_final.meta.series_generated_ts, 2000);
    assert.equal(chart.ml_final.meta.latest_attempt.series_run_id, "IR-failed-attempt");
    assert.equal(chart.ml_final.meta.latest_attempt.authoritative_write_status, "failed");

    // Challenger failure describes the candidate only. A successful fallback
    // current write remains the exact authoritative series despite run_status.
    const dayFallback = "2026-07-02";
    addIntradayBatch(dayFallback, "IR-active-fallback", 4000);
    addAudit({
      target_date: dayFallback,
      generated_ts: 4000,
      series_run_id: "IR-active-fallback",
      run_status: "fallback",
      challenger_status: "failed",
      authoritative_write_status: "success",
      authoritative_algorithm: "current_ratio_v1",
      configured_mode: "active",
      notes: { fallback_reason: "challenger_timeout" },
    });
    chart = await getChart(dayFallback);
    assert.equal(chart.ml_final.meta.provenance_status, "matched");
    assert.equal(chart.ml_final.meta.authoritative_status, "success");
    assert.equal(chart.ml_final.meta.series_algorithm, "current_ratio_v1");
    assert.equal(chart.ml_final.meta.challenger_meta.status, "failed");
    assert.equal(chart.ml_final.meta.fallback_used, true);

    // Historical shadow diagnostics are driven by the matching historical audit,
    // not hidden or rewritten by today's now-off setting.
    const dayShadow = "2026-07-03";
    addIntradayBatch(dayShadow, "IR-shadow-current", 5000);
    addAudit({
      target_date: dayShadow,
      generated_ts: 5000,
      series_run_id: "IR-shadow-current",
      execution_mode: "shadow",
      configured_mode: "shadow",
      challenger_status: "success",
      authoritative_algorithm: "current_ratio_v1",
      notes: { challenger_would_write: true, checkpoints: { "15": { p50_kwh: 12 } } },
    });
    chart = await getChart(dayShadow);
    assert.equal(chart.ml_final.meta.configured_mode, "shadow");
    assert.equal(chart.ml_final.meta.series_algorithm, "current_ratio_v1");
    assert.equal(chart.ml_final.meta.challenger_meta.algorithm_version, "robust_decay_v1");
    assert.equal(chart.ml_final.meta.challenger_meta.evaluation_only, true);

    // A day-ahead fallback may expose latest-attempt diagnostics, but must never
    // attach that intraday audit as the plotted series provenance.
    const dayAheadOnly = "2026-07-04";
    addDayAheadBatch(dayAheadOnly, 6000);
    addAudit({
      target_date: dayAheadOnly,
      generated_ts: 6000,
      series_run_id: "IR-not-persisted",
      authoritative_algorithm: "robust_decay_v1",
    });
    chart = await getChart(dayAheadOnly);
    assert.equal(chart.ml_final.meta.series_kind, "dayahead_fallback");
    assert.equal(chart.ml_final.meta.series_run_id, null);
    assert.equal(chart.ml_final.meta.series_algorithm, "dayahead");
    assert.equal(chart.ml_final.meta.provenance_status, "not_applicable");
    assert.equal(chart.ml_final.meta.latest_attempt.series_run_id, "IR-not-persisted");

    // Mixed batch ids are explicitly unknown even if either id has an audit.
    const dayMixed = "2026-07-05";
    addIntradayBatch(dayMixed, ["IR-mixed-a", "IR-mixed-b"], 7000);
    addAudit({ target_date: dayMixed, generated_ts: 7000, series_run_id: "IR-mixed-a" });
    chart = await getChart(dayMixed);
    assert.equal(chart.ml_final.meta.series_run_id, null);
    assert.equal(chart.ml_final.meta.series_algorithm, "unknown");
    assert.equal(chart.ml_final.meta.provenance_status, "unknown");

    console.log("forecastIntradayProvenance.test.js: PASS");
  } finally {
    try {
      await Promise.race([
        serverModule.shutdownEmbedded(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (_) {}
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("forecastIntradayProvenance.test.js: FAIL", error?.stack || error);
    process.exit(1);
  });
