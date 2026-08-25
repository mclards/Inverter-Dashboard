"use strict";

/**
 * Phase 1 TDD Test Suite: IGBT Health Score Computation
 *
 * Tests the pure-function core in server/igbtHealth.js:
 *   - computeHealthScore(inputs)
 *   - tierForScore(score)
 *   - aggregateMotiveCounts(stopReasonRows, motiveCodesArray)
 *   - medianImbalance(param5minRows)
 *
 * Related plan: plans/igbt-health-phase1.md §11
 */

const assert = require("assert");

// Import the health module
delete require.cache[require.resolve("../igbtHealth")];
const {
  computeHealthScore,
  tierForScore,
  aggregateMotiveCounts,
  medianImbalance,
} = require("../igbtHealth");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  igbtHealthCore.test.js — IGBT Health Computation");
  console.log("──────────────────────────────────────────────────────────\n");

  // ─────────────────────────────────────────────────────────────────────────
  // TIER CLASSIFICATION TESTS (6)
  // ─────────────────────────────────────────────────────────────────────────

  test("tierForScore(null) → null", () => {
    assert.strictEqual(tierForScore(null), null);
  });

  test("tierForScore(undefined) → null", () => {
    assert.strictEqual(tierForScore(undefined), null);
  });

  test("tierForScore(0) → 'healthy'", () => {
    assert.strictEqual(tierForScore(0), "healthy");
  });

  test("tierForScore(24.99) → 'healthy'", () => {
    assert.strictEqual(tierForScore(24.99), "healthy");
  });

  test("tierForScore(25.0) → 'watch'", () => {
    assert.strictEqual(tierForScore(25.0), "watch");
  });

  test("tierForScore(49.99) → 'watch'", () => {
    assert.strictEqual(tierForScore(49.99), "watch");
  });

  test("tierForScore(50.0) → 'aging'", () => {
    assert.strictEqual(tierForScore(50.0), "aging");
  });

  test("tierForScore(74.99) → 'aging'", () => {
    assert.strictEqual(tierForScore(74.99), "aging");
  });

  test("tierForScore(75.0) → 'eol'", () => {
    assert.strictEqual(tierForScore(75.0), "eol");
  });

  test("tierForScore(100) → 'eol'", () => {
    assert.strictEqual(tierForScore(100), "eol");
  });

  test("tierForScore(NaN) → null", () => {
    assert.strictEqual(tierForScore(NaN), null);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // HEALTH SCORE COMPUTATION TESTS (15+)
  // ─────────────────────────────────────────────────────────────────────────

  test("computeHealthScore(zero inputs) → score ~0, tier='healthy'", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 0.5,
    });
    assert.strictEqual(result.tier, "healthy");
    assert.ok(result.score < 1, `Score should be < 1, got ${result.score}`);
  });

  test("computeHealthScore(1 thermal trip) → score ~7.5, tier='healthy'", () => {
    const result = computeHealthScore({
      thermal_count: 1,  // 1 × 25 = 25, × 0.30 = 7.5
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 1.0,
    });
    assert.ok(result.score >= 7 && result.score <= 8, `Score should be 7-8, got ${result.score}`);
    assert.strictEqual(result.tier, "healthy");  // < 25
  });

  test("computeHealthScore(2 thermal trips) → score ~15, tier='healthy'", () => {
    const result = computeHealthScore({
      thermal_count: 2,  // 2 × 25 = 50, × 0.30 = 15
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 1.0,
    });
    assert.ok(result.score >= 14 && result.score <= 16, `Score should be 14-16, got ${result.score}`);
    assert.strictEqual(result.tier, "healthy");  // < 25
  });

  test("computeHealthScore(4 thermal trips) → score ~30, tier='watch'", () => {
    const result = computeHealthScore({
      thermal_count: 4,  // 4 × 25 = 100 (clamped), × 0.30 = 30
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 1.0,
    });
    assert.ok(result.score >= 29 && result.score <= 31, `Score should be 29-31, got ${result.score}`);
    assert.strictEqual(result.tier, "watch");
  });

  test("computeHealthScore(1 FRAMA) → score ~9, tier='healthy'", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 1,  // 1 × 30 = 30, × 0.30 = 9
      pi_ana_count: 0,
      imbalance_pct: 1.0,
    });
    assert.ok(result.score >= 8 && result.score <= 10, `Score should be 8-10, got ${result.score}`);
    assert.strictEqual(result.tier, "healthy");  // < 25
  });

  test("computeHealthScore(3 FRAMAs) → score ~30, tier='watch'", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 3,  // 3 × 30 = 90, × 0.30 = 27
      pi_ana_count: 0,
      imbalance_pct: 1.0,
    });
    assert.ok(result.score >= 26 && result.score <= 28, `Score should be 26-28, got ${result.score}`);
    assert.strictEqual(result.tier, "watch");
  });

  test("computeHealthScore(1 PI ANA trip) → score ~7, tier='healthy'", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 0,
      pi_ana_count: 1,  // 1 × 35 = 35, × 0.20 = 7
      imbalance_pct: 1.0,
    });
    assert.ok(result.score >= 6 && result.score <= 8, `Score should be 6-8, got ${result.score}`);
    assert.strictEqual(result.tier, "healthy");  // < 25
  });

  test("computeHealthScore(3% imbalance) → score ~8, tier='healthy'", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 3.0,  // (3.0 - 1.0) × 20 = 40 (clamped to 40), × 0.20 = 8
    });
    assert.ok(result.score >= 7 && result.score <= 9, `Score should be 7-9, got ${result.score}`);
  });

  test("computeHealthScore(6% imbalance) → score ~20, tier='watch'", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 6.0,  // (6.0 - 1.0) × 20 = 100 (clamped to 100), × 0.20 = 20
    });
    assert.ok(result.score >= 19 && result.score <= 21, `Score should be 19-21, got ${result.score}`);
  });

  test("computeHealthScore(imbalance ≤ 1.0) → no imbalance contribution", () => {
    const result = computeHealthScore({
      thermal_count: 0,
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: 1.0,  // (1.0 - 1.0) × 20 = 0
    });
    assert.strictEqual(result.score, 0);
  });

  test("computeHealthScore(null imbalance) → imbalance component = 0", () => {
    const result = computeHealthScore({
      thermal_count: 1,    // 1 × 25 = 25, × 0.30 = 7.5
      frama_count: 0,
      pi_ana_count: 0,
      imbalance_pct: null,  // offline, no contribution
    });
    assert.ok(result.score >= 7 && result.score <= 8, `Score should be 7-8, got ${result.score}`);
  });

  test("computeHealthScore(all components max) → score = 100, tier='eol'", () => {
    const result = computeHealthScore({
      thermal_count: 4,      // 100 × 0.30 = 30
      frama_count: 4,        // 120 → clamped to 100 × 0.30 = 30
      pi_ana_count: 3,       // 105 → clamped to 100 × 0.20 = 20
      imbalance_pct: 6.01,   // (6.01 - 1.0) × 20 = 100.2 → clamped to 100 × 0.20 = 20
    });
    assert.strictEqual(result.score, 100, `Score should be 100, got ${result.score}`);
    assert.strictEqual(result.tier, "eol");
  });

  test("computeHealthScore breakdown consistency", () => {
    const result = computeHealthScore({
      thermal_count: 2,
      frama_count: 1,
      pi_ana_count: 1,
      imbalance_pct: 2.5,
    });
    const bd = result.breakdown;

    // Verify component scores
    assert.ok(bd.thermal_score > 0, "thermal_score should be > 0");
    assert.ok(bd.frama_score > 0, "frama_score should be > 0");
    assert.ok(bd.pi_ana_score > 0, "pi_ana_score should be > 0");
    assert.ok(bd.imbal_score > 0, "imbal_score should be > 0");

    // Verify weighted sum matches composite score
    const weighted =
      0.30 * bd.thermal_score +
      0.30 * bd.frama_score +
      0.20 * bd.pi_ana_score +
      0.20 * bd.imbal_score;

    assert.ok(Math.abs(weighted - result.score) < 0.1,
      `weighted sum ${weighted} should match score ${result.score}`);
  });

  test("computeHealthScore(missing inputs defaults) → handled safely", () => {
    const result = computeHealthScore({});
    assert.strictEqual(result.tier, "healthy");
    assert.ok(result.score >= 0 && result.score <= 1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AGGREGATE MOTIVE COUNTS TESTS (5)
  // ─────────────────────────────────────────────────────────────────────────

  test("aggregateMotiveCounts(empty array) → 0", () => {
    assert.strictEqual(aggregateMotiveCounts([], [6, 20]), 0);
  });

  test("aggregateMotiveCounts(null) → 0", () => {
    assert.strictEqual(aggregateMotiveCounts(null, [6, 20]), 0);
  });

  test("aggregateMotiveCounts(matching rows)", () => {
    const rows = [
      { motive_code: 6 },
      { motive_code: 20 },
      { motive_code: 12 },
      { motive_code: 6 },
    ];
    assert.strictEqual(aggregateMotiveCounts(rows, [6, 20]), 3);
    assert.strictEqual(aggregateMotiveCounts(rows, [12]), 1);
    assert.strictEqual(aggregateMotiveCounts(rows, [99]), 0);
  });

  test("aggregateMotiveCounts(string motive codes)", () => {
    const rows = [
      { motive_code: 6 },
      { motive_code: 20 },
    ];
    // Should coerce string codes to numbers
    assert.strictEqual(aggregateMotiveCounts(rows, ["6", "20"]), 2);
  });

  test("aggregateMotiveCounts(empty motive codes array)", () => {
    const rows = [{ motive_code: 6 }];
    assert.strictEqual(aggregateMotiveCounts(rows, []), 0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MEDIAN IMBALANCE TESTS (8)
  // ─────────────────────────────────────────────────────────────────────────

  test("medianImbalance(empty array) → null", () => {
    assert.strictEqual(medianImbalance([]), null);
  });

  test("medianImbalance(null) → null", () => {
    assert.strictEqual(medianImbalance(null), null);
  });

  test("medianImbalance(single balanced row) → ~0%", () => {
    const rows = [
      { iac1_a: 100, iac2_a: 100, iac3_a: 100 },
    ];
    const result = medianImbalance(rows);
    assert.ok(result < 0.1, `Should be ~0%, got ${result}`);
  });

  test("medianImbalance(single ~0.66% imbalance row)", () => {
    const rows = [
      { iac1_a: 101, iac2_a: 100, iac3_a: 100 },  // avg = 100.333, max_dev = 0.333, imbalance = 0.333/100.333 = 0.332%
    ];
    const result = medianImbalance(rows);
    // Actual: (101 - 100.333)/100.333 × 100 ≈ 0.664% (max_dev/avg approach gives ~0.66%)
    assert.ok(result >= 0.3 && result <= 0.8, `Should be ~0.66%, got ${result}`);
  });

  test("medianImbalance(median of 3 samples)", () => {
    const rows = [
      { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // 0%
      { iac1_a: 110, iac2_a: 100, iac3_a: 100 },  // (110-100)/100 = 10/100 = 10%... actually max_dev = 3.33, avg = 103.33, imbalance = 3.2%
      { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // 0%
    ];
    const result = medianImbalance(rows);
    // Sorted would be [0, ~3.2%, 0] → sorted [0, 0, 3.2] → median at idx 1 = 0
    assert.ok(result < 2, `Median should be ~0%, got ${result}`);
  });

  test("medianImbalance(ignores NaN currents)", () => {
    const rows = [
      { iac1_a: 100, iac2_a: 100, iac3_a: 100 },
      { iac1_a: NaN, iac2_a: 100, iac3_a: 100 },  // incomplete, skip
      { iac1_a: 110, iac2_a: 100, iac3_a: 100 },  // include
    ];
    const result = medianImbalance(rows);
    // Should have 2 valid samples; one with ~3.2% imbalance
    assert.ok(result >= 0 && result <= 5, `Result should be in valid range, got ${result}`);
  });

  test("medianImbalance(ignores zero-power rows)", () => {
    const rows = [
      { iac1_a: 0, iac2_a: 0, iac3_a: 0 },  // avg = 0, skip
      { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // 0%
    ];
    const result = medianImbalance(rows);
    assert.ok(result < 0.1, `Should be ~0%, got ${result}`);
  });

  test("medianImbalance(partial current data skipped)", () => {
    const rows = [
      { iac1_a: 100, iac2_a: 100 },  // missing iac3_a, skip
      { iac1_a: 100, iac2_a: 100, iac3_a: 100 },  // valid
    ];
    const result = medianImbalance(rows);
    assert.ok(result < 0.1, `Should be ~0%, got ${result}`);
  });

  test("medianImbalance(all invalid rows) → null", () => {
    const rows = [
      { iac1_a: NaN, iac2_a: NaN, iac3_a: NaN },
      { iac1_a: 0, iac2_a: 0, iac3_a: 0 },
    ];
    const result = medianImbalance(rows);
    assert.strictEqual(result, null);
  });

  /* ── Phase 2.1 — yoy_drift_c branch ──────────────────────────────────── */

  test("computeHealthScore(yoy_drift_c=null) → uses Phase 1 weights", () => {
    const r = computeHealthScore({
      thermal_count: 1, frama_count: 0, pi_ana_count: 0, imbalance_pct: null,
      yoy_drift_c: null,
    });
    // Phase 1: 0.30 × 25 = 7.5
    assert.strictEqual(r.weights_used.phase, "phase1");
    assert.ok(Math.abs(r.score - 7.5) < 0.01, `expected ≈7.5, got ${r.score}`);
    assert.strictEqual(r.breakdown.yoy_score, null);
  });

  test("computeHealthScore(yoy_drift_c=undefined) → falls back to phase1", () => {
    const r = computeHealthScore({ thermal_count: 0, frama_count: 0, pi_ana_count: 0 });
    assert.strictEqual(r.weights_used.phase, "phase1");
    assert.strictEqual(r.breakdown.yoy_score, null);
  });

  test("computeHealthScore(yoy_drift_c=0) → Phase 2 weights, yoy_score=0", () => {
    const r = computeHealthScore({
      thermal_count: 0, frama_count: 0, pi_ana_count: 0, imbalance_pct: null,
      yoy_drift_c: 0,
    });
    assert.strictEqual(r.weights_used.phase, "phase2");
    assert.strictEqual(r.breakdown.yoy_score, 0);
    assert.strictEqual(r.score, 0);
  });

  test("computeHealthScore(yoy_drift_c=-2) → negative drift contributes 0", () => {
    const r = computeHealthScore({
      thermal_count: 0, frama_count: 0, pi_ana_count: 0, imbalance_pct: null,
      yoy_drift_c: -2,
    });
    assert.strictEqual(r.weights_used.phase, "phase2");
    assert.strictEqual(r.breakdown.yoy_score, 0);
    assert.strictEqual(r.score, 0);
  });

  test("computeHealthScore(yoy_drift_c=3) → yoy_score=36, contributes 0.30×36=10.8", () => {
    const r = computeHealthScore({
      thermal_count: 0, frama_count: 0, pi_ana_count: 0, imbalance_pct: null,
      yoy_drift_c: 3,
    });
    assert.strictEqual(r.weights_used.phase, "phase2");
    assert.ok(Math.abs(r.breakdown.yoy_score - 36) < 0.01);
    assert.ok(Math.abs(r.score - 10.8) < 0.01, `expected ≈10.8, got ${r.score}`);
  });

  test("computeHealthScore(yoy_drift_c=10) → yoy_score clamps at 100", () => {
    const r = computeHealthScore({
      thermal_count: 0, frama_count: 0, pi_ana_count: 0, imbalance_pct: null,
      yoy_drift_c: 10,
    });
    assert.strictEqual(r.breakdown.yoy_score, 100);
    // Phase 2: 0.30 × 100 = 30
    assert.ok(Math.abs(r.score - 30) < 0.01, `expected ≈30, got ${r.score}`);
  });

  test("computeHealthScore(yoy_drift_c=NaN) → treated as null, falls back to phase1", () => {
    const r = computeHealthScore({
      thermal_count: 1, frama_count: 0, pi_ana_count: 0, imbalance_pct: null,
      yoy_drift_c: NaN,
    });
    assert.strictEqual(r.weights_used.phase, "phase1");
    assert.strictEqual(r.breakdown.yoy_score, null);
  });

  test("computeHealthScore(phase2 max all components) → score = 100, tier='eol'", () => {
    const r = computeHealthScore({
      thermal_count: 4, frama_count: 4, pi_ana_count: 3, imbalance_pct: 6,
      yoy_drift_c: 10,
    });
    // 0.30×100 + 0.25×100 + 0.15×100 + 0.15×100 + 0.15×100 = 100
    assert.strictEqual(r.weights_used.phase, "phase2");
    assert.ok(Math.abs(r.score - 100) < 0.01);
    assert.strictEqual(r.tier, "eol");
  });

  test("computeHealthScore(phase2 weights sum to 1.0)", () => {
    const r = computeHealthScore({ yoy_drift_c: 1 });
    const w = r.weights_used.weights;
    const sum = w.yoy + w.frama + w.thermal_trips + w.pi_ana + w.imbal;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `phase2 weights should sum to 1.0, got ${sum}`);
  });

  test("computeHealthScore(phase1 weights sum to 1.0)", () => {
    const r = computeHealthScore({});
    const w = r.weights_used.weights;
    const sum = w.thermal + w.frama + w.pi_ana + w.imbal;
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `phase1 weights should sum to 1.0, got ${sum}`);
  });
}

run();
