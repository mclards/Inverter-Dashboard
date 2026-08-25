"use strict";

/**
 * apcRampLimiterCore.test.js — APC ramp-rate limiter pure-function tests.
 * Plan: plans/2026-05-12-ppc-capabilities-implementation.md §3
 */

const assert = require("assert");

delete require.cache[require.resolve("../apcRampLimiter")];
const {
  planRamp,
  DEFAULT_STEP_INTERVAL_MS,
  ABSOLUTE_MIN_STEP_PCT,
  MAX_PLAN_STEPS,
} = require("../apcRampLimiter");

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); process.exitCode = 1; }
}
function approxEq(a, b, tol = 1e-6) {
  assert.ok(Math.abs(Number(a) - Number(b)) <= tol, `expected ${a} ≈ ${b} (±${tol})`);
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  apcRampLimiterCore.test.js — pure ramp pacer");
  console.log("──────────────────────────────────────────────────────────\n");

  test("disabled when rate ≤ 0", () => {
    const p = planRamp({ current_pct: 100, target_pct: 0, rate_pct_per_min: 0 });
    assert.strictEqual(p.throttled, false);
    assert.strictEqual(p.immediate_pct, 0);
    assert.deepStrictEqual(p.remaining_steps, []);
  });

  test("disabled when rate non-finite", () => {
    const p = planRamp({ current_pct: 100, target_pct: 50, rate_pct_per_min: NaN });
    assert.strictEqual(p.throttled, false);
    assert.strictEqual(p.immediate_pct, 50);
  });

  test("missing current → single immediate step", () => {
    const p = planRamp({ current_pct: null, target_pct: 50, rate_pct_per_min: 10 });
    assert.strictEqual(p.throttled, false);
    assert.strictEqual(p.immediate_pct, 50);
  });

  test("delta within one step → single immediate", () => {
    // rate=10%/min, interval=15s → stepPct = 2.5
    const p = planRamp({
      current_pct: 50, target_pct: 52, rate_pct_per_min: 10,
      step_interval_ms: 15_000, now_ms: 0,
    });
    assert.strictEqual(p.throttled, false);
    assert.strictEqual(p.immediate_pct, 52);
  });

  test("large downward step → plan multiple paced steps", () => {
    // Drop 100 → 0 at 10%/min, 15-s intervals → step=2.5%, n=40 steps.
    // Capped at MAX_PLAN_STEPS=60 (so all 40 fit).
    const p = planRamp({
      current_pct: 100, target_pct: 0, rate_pct_per_min: 10,
      step_interval_ms: 15_000, now_ms: 0,
    });
    assert.strictEqual(p.throttled, true);
    // step count = 40, with 1 immediate + 39 remaining
    assert.strictEqual(p.remaining_steps.length, 39);
    // First paced step lands at 97.5%
    approxEq(p.immediate_pct, 97.5);
    // Final step lands EXACTLY at 0
    approxEq(p.remaining_steps[p.remaining_steps.length - 1].pct, 0);
    // Final delay = 39 × 15_000 ms
    assert.strictEqual(p.remaining_steps[p.remaining_steps.length - 1].delay_ms, 39 * 15_000);
  });

  test("upward ramp also throttles", () => {
    const p = planRamp({
      current_pct: 20, target_pct: 80, rate_pct_per_min: 10,
      step_interval_ms: 15_000, now_ms: 0,
    });
    assert.strictEqual(p.throttled, true);
    // delta = 60, step = 2.5, n = 24 → 1 immediate + 23 remaining
    assert.strictEqual(p.remaining_steps.length, 23);
    approxEq(p.immediate_pct, 22.5);
    approxEq(p.remaining_steps.at(-1).pct, 80);
  });

  test("respects MAX_PLAN_STEPS cap (huge delta + tiny rate)", () => {
    // rate=1%/min, interval=15s → stepPct=0.25%. Delta = 100. n_ideal = 400.
    // Capped to MAX_PLAN_STEPS=60.
    const p = planRamp({
      current_pct: 100, target_pct: 0, rate_pct_per_min: 1,
      step_interval_ms: 15_000, now_ms: 0,
    });
    assert.strictEqual(p.throttled, true);
    // 1 immediate + (MAX_PLAN_STEPS - 1) remaining
    assert.strictEqual(p.remaining_steps.length, MAX_PLAN_STEPS - 1);
    approxEq(p.remaining_steps.at(-1).pct, 0);
  });

  test("respects ABSOLUTE_MIN_STEP_PCT for impossibly tiny rate", () => {
    // rate=0.1%/min, interval=1s → mathematical stepPct=0.00167%, clamped to 0.5.
    const p = planRamp({
      current_pct: 100, target_pct: 0, rate_pct_per_min: 0.1,
      step_interval_ms: 1000, now_ms: 0,
    });
    // 100 / 0.5 = 200 ideal steps, capped to MAX_PLAN_STEPS.
    assert.strictEqual(p.throttled, true);
    assert.strictEqual(p.remaining_steps.length, MAX_PLAN_STEPS - 1);
  });

  test("clamps target and current to [0..100]", () => {
    const p = planRamp({
      current_pct: 150, target_pct: -10, rate_pct_per_min: 10,
      step_interval_ms: 15_000, now_ms: 0,
    });
    // current clamped to 100, target clamped to 0 → standard 40-step ramp
    assert.strictEqual(p.throttled, true);
    assert.strictEqual(p.remaining_steps.length, 39);
    approxEq(p.remaining_steps.at(-1).pct, 0);
  });

  test("zero-delta returns immediate without throttle flag", () => {
    const p = planRamp({
      current_pct: 50, target_pct: 50, rate_pct_per_min: 10,
      step_interval_ms: 15_000, now_ms: 0,
    });
    assert.strictEqual(p.throttled, false);
    assert.strictEqual(p.immediate_pct, 50);
  });

  test("DEFAULT_STEP_INTERVAL_MS is used when interval omitted", () => {
    const p = planRamp({
      current_pct: 100, target_pct: 0, rate_pct_per_min: 10, now_ms: 0,
    });
    // With default 15 000 ms and rate 10 → same 40 steps
    assert.strictEqual(p.throttled, true);
    assert.strictEqual(p.remaining_steps.length, 39);
    // First remaining_step delay = 1 × DEFAULT_STEP_INTERVAL_MS
    assert.strictEqual(p.remaining_steps[0].delay_ms, DEFAULT_STEP_INTERVAL_MS);
  });

  console.log(
    process.exitCode === 1
      ? "\n  ✗ apcRampLimiterCore tests FAILED\n"
      : "\n  ✓ apcRampLimiterCore tests passed\n",
  );
}

run();
