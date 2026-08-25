"use strict";

/**
 * IGBT Health Phase 2.1 — thermal baseline pure-function core tests.
 *
 * Tests:
 *   • computeDailyBaseline(rows, ratedKw)        — filters + mean
 *   • aggregateMeanTemp(baselineRows)            — 30-day rolling mean
 *   • computeYoYDrift(currentMean, priorMean)    — drift or null
 *   • thermalDriftScore(yoy_drift_c)             — manual §6.5
 *   • baselineProgress(rowCount, targetDays)     — readiness ratio
 *
 * Related plan: plans/igbt-health-phase1.md (Phase 2 deferred section)
 */

const assert = require("assert");

let computeDailyBaseline;
let aggregateMeanTemp;
let computeYoYDrift;
let thermalDriftScore;
let baselineProgress;
try {
  const mod = require("../igbtThermal");
  ({ computeDailyBaseline, aggregateMeanTemp, computeYoYDrift, thermalDriftScore, baselineProgress } = mod);
} catch (err) {
  console.error(`FAILED TO IMPORT: ${err.message}`);
  process.exitCode = 1;
  process.exit(1);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  igbtThermalCore.test.js — IGBT thermal baseline pure-fns");
  console.log("────────────────────────────────────────────────────────────\n");

  // Helper: build a fake 5-min row at a given slot/PAC/temp
  const row = (slot, pac_w, temp_c) => ({ slot_index: slot, pac_w, temp_c });

  // ─── computeDailyBaseline ──────────────────────────────────────────────
  test("computeDailyBaseline: empty rows -> reason=no_data, mean=null", () => {
    const r = computeDailyBaseline([], 100);
    assert.strictEqual(r.reason, "no_data");
    assert.strictEqual(r.mean_temp_c, null);
    assert.strictEqual(r.sample_count, 0);
  });

  test("computeDailyBaseline: invalid ratedKw -> reason=no_rated_kw, mean=null", () => {
    const r1 = computeDailyBaseline([row(140, 70000, 55)], 0);
    assert.strictEqual(r1.reason, "no_rated_kw");
    const r2 = computeDailyBaseline([row(140, 70000, 55)], null);
    assert.strictEqual(r2.reason, "no_rated_kw");
  });

  test("computeDailyBaseline: filters by midday slot window 132-167 (11:00-13:55)", () => {
    // ratedKw=100 -> nominal=100,000 W; 60-85% band = 60,000-85,000 W
    // slot 100 (~08:20) outside midday
    // slot 140 (~11:40) in window
    // slot 168 (14:00) just outside window (window is 132 inclusive, 168 exclusive)
    // slot 200 (~16:40) outside
    const rows = [
      row(100, 70000, 55),  // outside midday
      row(140, 70000, 60),  // PASS
      row(150, 70000, 62),  // PASS
      row(155, 70000, 64),  // PASS
      row(160, 70000, 65),  // PASS
      row(165, 70000, 66),  // PASS
      row(167, 70000, 68),  // PASS (last in-window slot)
      row(168, 70000, 90),  // outside midday (just)
      row(200, 70000, 90),  // outside midday
    ];
    const r = computeDailyBaseline(rows, 100);
    assert.strictEqual(r.reason, "computed");
    assert.strictEqual(r.sample_count, 6);
    // Mean of [60, 62, 64, 65, 66, 68] = 64.166...
    assert.ok(Math.abs(r.mean_temp_c - 64.166666) < 0.01, `expected ~64.17 got ${r.mean_temp_c}`);
  });

  test("computeDailyBaseline: filters by power band 60-85% of nominal", () => {
    // ratedKw=100 -> nominal=100,000 W; band = 60,000-85,000 W
    // Need >= MIN_SAMPLES (6) in-band rows to qualify.
    const rows = [
      row(140, 50000, 50),  // 50% — too low (excluded)
      row(141, 60000, 55),  // 60% — PASS (boundary)
      row(142, 65000, 56),  // 65% — PASS
      row(143, 70000, 58),  // 70% — PASS
      row(144, 75000, 60),  // 75% — PASS
      row(145, 80000, 62),  // 80% — PASS
      row(146, 85000, 64),  // 85% — PASS (boundary)
      row(147, 90000, 70),  // 90% — too high (excluded)
      row(148, 100000, 80), // 100% — too high (excluded)
    ];
    const r = computeDailyBaseline(rows, 100);
    assert.strictEqual(r.reason, "computed");
    assert.strictEqual(r.sample_count, 6);
    // Mean of [55, 56, 58, 60, 62, 64] = 59.166...
    assert.ok(Math.abs(r.mean_temp_c - 59.17) < 0.01, `expected ~59.17 got ${r.mean_temp_c}`);
  });

  test("computeDailyBaseline: rejects fewer than 6 samples (insufficient_samples)", () => {
    const rows = [
      row(140, 70000, 60),
      row(141, 70000, 62),
      row(142, 70000, 64),
      row(143, 70000, 65),
      row(144, 70000, 66),
    ];
    const r = computeDailyBaseline(rows, 100);
    assert.strictEqual(r.reason, "insufficient_samples");
    assert.strictEqual(r.sample_count, 5);
    assert.strictEqual(r.mean_temp_c, null);
  });

  test("computeDailyBaseline: skips rows with non-finite temp", () => {
    const rows = [
      row(140, 70000, 60),
      row(141, 70000, NaN),
      row(142, 70000, 62),
      row(143, 70000, null),
      row(144, 70000, 64),
      row(145, 70000, 65),
      row(146, 70000, 66),
      row(147, 70000, undefined),
    ];
    const r = computeDailyBaseline(rows, 100);
    assert.strictEqual(r.sample_count, 5);  // 5 valid, but < 6 -> insufficient
    assert.strictEqual(r.reason, "insufficient_samples");
  });

  test("computeDailyBaseline: skips rows with non-positive temp", () => {
    const rows = [
      row(140, 70000, 60),
      row(141, 70000, 0),    // zero excluded
      row(142, 70000, -5),   // negative excluded
      row(143, 70000, 62),
      row(144, 70000, 64),
      row(145, 70000, 65),
      row(146, 70000, 66),
      row(147, 70000, 68),
    ];
    const r = computeDailyBaseline(rows, 100);
    assert.strictEqual(r.sample_count, 6);
    assert.strictEqual(r.reason, "computed");
  });

  test("computeDailyBaseline: respects optional excludeDay flag", () => {
    const rows = [
      row(140, 70000, 60),
      row(141, 70000, 62),
      row(142, 70000, 64),
      row(143, 70000, 65),
      row(144, 70000, 66),
      row(145, 70000, 68),
    ];
    const r = computeDailyBaseline(rows, 100, { excludeDay: true });
    assert.strictEqual(r.reason, "excluded_stop_event");
    assert.strictEqual(r.mean_temp_c, null);
    assert.strictEqual(r.sample_count, 0);
  });

  test("computeDailyBaseline: rounds mean to 2 decimals", () => {
    const rows = [
      row(140, 70000, 60.123),
      row(141, 70000, 62.456),
      row(142, 70000, 64.789),
      row(143, 70000, 65.012),
      row(144, 70000, 66.345),
      row(145, 70000, 67.678),
    ];
    const r = computeDailyBaseline(rows, 100);
    assert.strictEqual(r.reason, "computed");
    // Should be rounded to 2 decimals
    assert.strictEqual(Number(r.mean_temp_c.toFixed(2)), r.mean_temp_c);
  });

  // ─── aggregateMeanTemp ─────────────────────────────────────────────────
  test("aggregateMeanTemp: empty -> null", () => {
    assert.strictEqual(aggregateMeanTemp([]), null);
    assert.strictEqual(aggregateMeanTemp(null), null);
  });

  test("aggregateMeanTemp: averages only rows with reason=computed", () => {
    const rows = [
      { mean_temp_c: 60, reason: "computed" },
      { mean_temp_c: null, reason: "insufficient_samples" },
      { mean_temp_c: null, reason: "no_data" },
      { mean_temp_c: 64, reason: "computed" },
      { mean_temp_c: null, reason: "excluded_stop_event" },
      { mean_temp_c: 68, reason: "computed" },
    ];
    const r = aggregateMeanTemp(rows);
    // Mean of [60, 64, 68] = 64
    assert.strictEqual(r, 64);
  });

  test("aggregateMeanTemp: all-excluded -> null", () => {
    const rows = [
      { mean_temp_c: null, reason: "no_data" },
      { mean_temp_c: null, reason: "excluded_stop_event" },
    ];
    assert.strictEqual(aggregateMeanTemp(rows), null);
  });

  // ─── computeYoYDrift ───────────────────────────────────────────────────
  test("computeYoYDrift: null input -> null", () => {
    assert.strictEqual(computeYoYDrift(null, 60), null);
    assert.strictEqual(computeYoYDrift(60, null), null);
    assert.strictEqual(computeYoYDrift(null, null), null);
  });

  test("computeYoYDrift: positive drift (degraded)", () => {
    assert.strictEqual(computeYoYDrift(65, 60), 5);
  });

  test("computeYoYDrift: negative drift (improved/cooler)", () => {
    assert.strictEqual(computeYoYDrift(58, 60), -2);
  });

  test("computeYoYDrift: rounded to 2 decimals", () => {
    const r = computeYoYDrift(65.123, 60.456);
    assert.strictEqual(Number(r.toFixed(2)), r);
  });

  // ─── thermalDriftScore ─────────────────────────────────────────────────
  test("thermalDriftScore: null/undefined -> null", () => {
    assert.strictEqual(thermalDriftScore(null), null);
    assert.strictEqual(thermalDriftScore(undefined), null);
    assert.strictEqual(thermalDriftScore(NaN), null);
  });

  test("thermalDriftScore: 0 drift -> 0", () => {
    assert.strictEqual(thermalDriftScore(0), 0);
  });

  test("thermalDriftScore: negative drift (cooler) -> 0 (no penalty)", () => {
    assert.strictEqual(thermalDriftScore(-3), 0);
  });

  test("thermalDriftScore: 3 °C drift -> 36 (warning per manual §4.1.1)", () => {
    // Per manual §6.5: yoy_drift * 12, clamped to [0, 100]
    assert.strictEqual(thermalDriftScore(3), 36);
  });

  test("thermalDriftScore: 8 °C drift -> 96 (Critical per manual §6.5)", () => {
    assert.strictEqual(thermalDriftScore(8), 96);
  });

  test("thermalDriftScore: 10 °C drift -> 100 (clamped)", () => {
    assert.strictEqual(thermalDriftScore(10), 100);
  });

  // ─── baselineProgress ──────────────────────────────────────────────────
  test("baselineProgress: 0 days -> { ready:false, ratio:0 }", () => {
    const r = baselineProgress(0);
    assert.strictEqual(r.ready, false);
    assert.strictEqual(r.ratio, 0);
    assert.strictEqual(r.computed_days, 0);
  });

  test("baselineProgress: 180 days @ 365 target -> ratio ~0.493, not ready", () => {
    const r = baselineProgress(180);
    assert.strictEqual(r.ready, false);
    assert.ok(Math.abs(r.ratio - (180 / 365)) < 0.001, `expected ~0.493 got ${r.ratio}`);
    assert.strictEqual(r.computed_days, 180);
  });

  test("baselineProgress: 365 days -> { ready:true, ratio:1.0 }", () => {
    const r = baselineProgress(365);
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.ratio, 1);
  });

  test("baselineProgress: 1000 days -> { ready:true, ratio:1.0 (clamped) }", () => {
    const r = baselineProgress(1000);
    assert.strictEqual(r.ready, true);
    assert.strictEqual(r.ratio, 1);
  });

  test("baselineProgress: invalid input -> { ready:false, ratio:0 }", () => {
    const r1 = baselineProgress(null);
    assert.strictEqual(r1.ready, false);
    assert.strictEqual(r1.ratio, 0);
    const r2 = baselineProgress(NaN);
    assert.strictEqual(r2.ready, false);
  });

  test("baselineProgress: respects custom targetDays", () => {
    const r = baselineProgress(60, 90);
    assert.ok(Math.abs(r.ratio - (60 / 90)) < 0.001);
    assert.strictEqual(r.ready, false);
    const r2 = baselineProgress(90, 90);
    assert.strictEqual(r2.ready, true);
  });

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  All tests completed");
  console.log("────────────────────────────────────────────────────────────\n");
}

run();
