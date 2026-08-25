"use strict";

/**
 * acContactorHealthCore.test.js — AC Contactor health pure-function tests.
 *
 * Tests the pure-function core in server/acContactorHealth.js:
 *   - computeContactorScore(inputs)
 *   - tierForScore(score)
 *   - countContactorStops(rows)
 *   - countContactorAlarmEpisodes(rows)
 *   - detectChatter(rows, opts)
 *   - vacImbalanceUnderLoad(rows, opts)
 *   - iacImbalanceUnderLoad(rows, opts)
 *   - correlateWithIgbt({contactor, igbt})
 *
 * Mirrors the structure of igbtHealthCore.test.js so the harness can run
 * them side-by-side with the same Node-ABI smoke runner.
 */

const assert = require("assert");

delete require.cache[require.resolve("../acContactorHealth")];
const {
  computeContactorScore,
  tierForScore,
  countContactorStops,
  countContactorAlarmEpisodes,
  detectChatter,
  vacImbalanceUnderLoad,
  iacImbalanceUnderLoad,
  computeCycleRatePerDay,
  correlateWithIgbt,
  CONTACTOR_STOP_MOTIVES,
  ALARM_BIT_CONTACTOR_MASK,
  CYCLE_RATE_FLOOR_PER_DAY,
  CYCLE_RATE_CEIL_PER_DAY,
} = require("../acContactorHealth");

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

function approxEq(a, b, tol = 0.05) {
  assert.ok(
    Math.abs(a - b) <= tol,
    `expected ${a} ≈ ${b} (±${tol})`
  );
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  acContactorHealthCore.test.js — AC Contactor Health");
  console.log("──────────────────────────────────────────────────────────\n");

  // ── constants sanity ─────────────────────────────────────────────────────
  test("CONTACTOR_STOP_MOTIVES is frozen [22,23,24]", () => {
    assert.deepStrictEqual([...CONTACTOR_STOP_MOTIVES], [22, 23, 24]);
    assert.throws(() => { CONTACTOR_STOP_MOTIVES.push(99); });
  });

  test("ALARM_BIT_CONTACTOR_MASK is bit 11 (0x0800)", () => {
    assert.strictEqual(ALARM_BIT_CONTACTOR_MASK, 0x0800);
  });

  // ── tierForScore ─────────────────────────────────────────────────────────
  test("tierForScore: nulls and NaN → null", () => {
    assert.strictEqual(tierForScore(null), null);
    assert.strictEqual(tierForScore(undefined), null);
    assert.strictEqual(tierForScore(NaN), null);
    assert.strictEqual(tierForScore("abc"), null);
  });

  test("tierForScore: boundary scores 0/24.9/25/49.9/50/74.9/75/100", () => {
    assert.strictEqual(tierForScore(0),    "healthy");
    assert.strictEqual(tierForScore(24.9), "healthy");
    assert.strictEqual(tierForScore(25),   "watch");
    assert.strictEqual(tierForScore(49.9), "watch");
    assert.strictEqual(tierForScore(50),   "aging");
    assert.strictEqual(tierForScore(74.9), "aging");
    assert.strictEqual(tierForScore(75),   "eol");
    assert.strictEqual(tierForScore(100),  "eol");
  });

  // ── countContactorStops ──────────────────────────────────────────────────
  test("countContactorStops: empty/null inputs → 0", () => {
    assert.strictEqual(countContactorStops([]),       0);
    assert.strictEqual(countContactorStops(null),     0);
    assert.strictEqual(countContactorStops(undefined),0);
    assert.strictEqual(countContactorStops("nope"),   0);
  });

  test("countContactorStops: only motives 22/23/24 are counted", () => {
    const rows = [
      { motive_code: 22 },
      { motive_code: 23 },
      { motive_code: 24 },
      { motive_code: 7  }, // thermal — not contactor
      { motive_code: 26 }, // pi_ana — not contactor
      { motive_code: "24" }, // string variant should still match
      { motive_code: null }, // null safe
      {},                    // missing field
    ];
    assert.strictEqual(countContactorStops(rows), 4);
  });

  // ── countContactorAlarmEpisodes ─────────────────────────────────────────
  test("countContactorAlarmEpisodes: only bit 11 set is counted", () => {
    const rows = [
      { alarm_value: 0x0800 },           // bit 11 alone
      { alarm_value: 0x0800 | 0x0001 },  // bit 11 + bit 0
      { alarm_value: 0x0001 },           // bit 0 only — not contactor
      { alarm_value: 0 },                // cleared
      { alarm_value: null },
      { alarm_value: "garbage" },
    ];
    assert.strictEqual(countContactorAlarmEpisodes(rows), 2);
  });

  test("countContactorAlarmEpisodes: empty/null → 0", () => {
    assert.strictEqual(countContactorAlarmEpisodes([]),   0);
    assert.strictEqual(countContactorAlarmEpisodes(null), 0);
  });

  // ── detectChatter ────────────────────────────────────────────────────────
  test("detectChatter: counts short bit-11 episodes (<60 s default)", () => {
    const rows = [
      { ts: 1_000_000, cleared_ts: 1_005_000, alarm_value: 0x0800 }, // 5 s — chatter
      { ts: 1_010_000, cleared_ts: 1_040_000, alarm_value: 0x0800 }, // 30 s — chatter
      { ts: 1_100_000, cleared_ts: 1_200_000, alarm_value: 0x0800 }, // 100 s — NOT chatter (long fault)
      { ts: 1_300_000, cleared_ts: null,      alarm_value: 0x0800 }, // ongoing — NOT chatter
      { ts: 1_400_000, cleared_ts: 1_400_500, alarm_value: 0x0001 }, // wrong bit — ignored
    ];
    assert.strictEqual(detectChatter(rows), 2);
  });

  test("detectChatter: custom duration window works", () => {
    const rows = [
      { ts: 100, cleared_ts: 150, alarm_value: 0x0800 }, // 50 ms
      { ts: 200, cleared_ts: 500, alarm_value: 0x0800 }, // 300 ms
    ];
    assert.strictEqual(detectChatter(rows, { chatterMaxDurationMs: 100 }), 1);
    assert.strictEqual(detectChatter(rows, { chatterMaxDurationMs: 1000 }), 2);
  });

  // ── vacImbalanceUnderLoad ────────────────────────────────────────────────
  test("vacImbalanceUnderLoad: no rows / no load → null", () => {
    assert.strictEqual(vacImbalanceUnderLoad([]),   null);
    assert.strictEqual(vacImbalanceUnderLoad(null), null);
    assert.strictEqual(vacImbalanceUnderLoad([
      { vac1_v: 230, vac2_v: 230, vac3_v: 230, iac1_a: 0, iac2_a: 0, iac3_a: 0 },
    ]), null);
  });

  test("vacImbalanceUnderLoad: balanced 230 V under load → 0%", () => {
    const rows = [
      { vac1_v: 230, vac2_v: 230, vac3_v: 230, iac1_a: 50, iac2_a: 50, iac3_a: 50 },
      { vac1_v: 230, vac2_v: 230, vac3_v: 230, iac1_a: 60, iac2_a: 60, iac3_a: 60 },
    ];
    approxEq(vacImbalanceUnderLoad(rows), 0, 0.001);
  });

  test("vacImbalanceUnderLoad: 230/230/220 under load → ~4.3%", () => {
    // spread = (230-220)/avg(226.67) × 100 = 4.41%
    const rows = [
      { vac1_v: 230, vac2_v: 230, vac3_v: 220, iac1_a: 50, iac2_a: 50, iac3_a: 45 },
    ];
    approxEq(vacImbalanceUnderLoad(rows), 4.41, 0.05);
  });

  // ── iacImbalanceUnderLoad ────────────────────────────────────────────────
  test("iacImbalanceUnderLoad: balanced currents → 0%", () => {
    const rows = [
      { iac1_a: 50, iac2_a: 50, iac3_a: 50 },
    ];
    approxEq(iacImbalanceUnderLoad(rows), 0, 0.001);
  });

  test("iacImbalanceUnderLoad: 50/50/40 → max dev 6.67 / avg 46.67 = ~14.3%", () => {
    const rows = [
      { iac1_a: 50, iac2_a: 50, iac3_a: 40 },
    ];
    approxEq(iacImbalanceUnderLoad(rows), 14.29, 0.05);
  });

  // ── computeContactorScore — component sanity ─────────────────────────────
  test("computeContactorScore: all-zero inputs → score 0, tier healthy", () => {
    const r = computeContactorScore({});
    assert.strictEqual(r.score, 0);
    assert.strictEqual(r.tier,  "healthy");
    assert.strictEqual(r.weights_used.phase, "phase1");
  });

  test("computeContactorScore: 1 stop only → weighted 30% × 35 = 10.5", () => {
    const r = computeContactorScore({ stop_count: 1 });
    approxEq(r.score, 10.5, 0.01);
    assert.strictEqual(r.tier, "healthy");
    assert.strictEqual(r.breakdown.stop_score, 35);
  });

  test("computeContactorScore: 3 stops + 2 alarm + 1 chatter → mid-watch tier", () => {
    // stop=100, alarm=50, chatter=50, vac=0, iac=0
    // weighted = 0.30*100 + 0.25*50 + 0.20*50 + 0 + 0 = 30 + 12.5 + 10 = 52.5
    const r = computeContactorScore({
      stop_count: 3,
      alarm_episode_count: 2,
      chatter_count: 1,
    });
    approxEq(r.score, 52.5, 0.05);
    assert.strictEqual(r.tier, "aging");
  });

  test("computeContactorScore: pinned at 100 only with maxed components", () => {
    const r = computeContactorScore({
      stop_count: 100,
      alarm_episode_count: 100,
      chatter_count: 100,
      vac_imbalance_pct: 99,
      iac_imbalance_pct: 99,
    });
    approxEq(r.score, 100, 0.05);
    assert.strictEqual(r.tier, "eol");
  });

  test("computeContactorScore: voltage imbalance below floor contributes 0", () => {
    const r = computeContactorScore({ vac_imbalance_pct: 0.5 });
    assert.strictEqual(r.breakdown.vac_score, 0);
  });

  test("computeContactorScore: voltage imbalance at ceil → 100", () => {
    const r = computeContactorScore({ vac_imbalance_pct: 6.0 });
    assert.strictEqual(r.breakdown.vac_score, 100);
  });

  test("computeContactorScore: weights sum to 1.0", () => {
    const r = computeContactorScore({});
    const w = r.weights_used.weights;
    const sum = w.stop + w.alarm + w.chatter + w.vac + w.iac;
    approxEq(sum, 1.0, 1e-9);
  });

  // ── correlateWithIgbt ────────────────────────────────────────────────────
  test("correlateWithIgbt: nothing meaningful → linked false, info severity", () => {
    const r = correlateWithIgbt({ contactor: {}, igbt: {} });
    assert.strictEqual(r.linked, false);
    assert.strictEqual(r.severity, "info");
    assert.deepStrictEqual(r.reasons, []);
  });

  test("correlateWithIgbt: chatter + FRAMA → act severity, R1 fires", () => {
    const r = correlateWithIgbt({
      contactor: { chatter_count: 2 },
      igbt: { frama_count: 1 },
    });
    assert.strictEqual(r.linked, true);
    assert.strictEqual(r.severity, "act");
    assert.ok(r.reasons.some(s => s.includes("FRAMA")));
  });

  test("correlateWithIgbt: contactor stops + IGBT imbalance → watch severity, R2 fires", () => {
    const r = correlateWithIgbt({
      contactor: { stop_count: 1 },
      igbt: { imbalance_pct: 7.5 },
    });
    assert.strictEqual(r.linked, true);
    assert.strictEqual(r.severity, "watch");
    assert.ok(r.reasons.some(s => s.includes("Phase-current imbalance")));
  });

  test("correlateWithIgbt: both tiers eol → act severity, R3 fires", () => {
    const r = correlateWithIgbt({
      contactor: { tier: "eol" },
      igbt: { tier: "eol" },
    });
    assert.strictEqual(r.linked, true);
    assert.strictEqual(r.severity, "act");
    assert.ok(r.reasons.some(s => s.includes("joint K1 + IGBT")));
  });

  test("correlateWithIgbt: thermal trips + chatter → R4 watch", () => {
    const r = correlateWithIgbt({
      contactor: { chatter_count: 1 },
      igbt: { thermal_count: 2 },
    });
    assert.strictEqual(r.linked, true);
    assert.ok(r.reasons.some(s => s.includes("thermal trip")));
  });

  // ── computeCycleRatePerDay ───────────────────────────────────────────────
  test("computeCycleRatePerDay: empty/null → no rate", () => {
    const r1 = computeCycleRatePerDay([]);
    assert.strictEqual(r1.rate_per_day, null);
    assert.strictEqual(r1.samples_used, 0);
    const r2 = computeCycleRatePerDay(null);
    assert.strictEqual(r2.rate_per_day, null);
  });

  test("computeCycleRatePerDay: single sample → no rate (need ≥2)", () => {
    const r = computeCycleRatePerDay([{ ts_ms: 1_000_000, value: 5000 }]);
    assert.strictEqual(r.rate_per_day, null);
    assert.strictEqual(r.samples_used, 1);
  });

  test("computeCycleRatePerDay: 5 cycles over exactly 1 day → 5/day", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const r = computeCycleRatePerDay([
      { ts_ms: t0,              value: 1000 },
      { ts_ms: t0 + 86_400_000, value: 1005 },
    ]);
    approxEq(r.rate_per_day, 5.0, 0.001);
    assert.strictEqual(r.total_delta, 5);
    approxEq(r.span_days, 1.0, 0.001);
  });

  test("computeCycleRatePerDay: monotone counter — ignores regressions", () => {
    // Sample 3 goes DOWN — reset or glitch; should be ignored.
    const t0 = Date.UTC(2026, 0, 1);
    const r = computeCycleRatePerDay([
      { ts_ms: t0,              value: 1000 },
      { ts_ms: t0 + 86_400_000, value: 1010 },  // +10
      { ts_ms: t0 + 86_400_000 * 2, value: 500 },  // regression — ignored
      { ts_ms: t0 + 86_400_000 * 3, value: 520 }, // +20
    ]);
    // Total monotone delta = 10 + (negative ignored) + 20 = 30 cycles over 3 days
    assert.strictEqual(r.total_delta, 30);
    approxEq(r.rate_per_day, 10.0, 0.001);
  });

  test("computeCycleRatePerDay: < 1 h span → no rate (not statistically meaningful)", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const r = computeCycleRatePerDay([
      { ts_ms: t0,            value: 1000 },
      { ts_ms: t0 + 60_000,   value: 1001 }, // 1 minute apart
    ]);
    assert.strictEqual(r.rate_per_day, null);
    assert.strictEqual(r.total_delta, 1);
  });

  test("computeCycleRatePerDay: skips zero / non-finite samples", () => {
    const t0 = Date.UTC(2026, 0, 1);
    const r = computeCycleRatePerDay([
      { ts_ms: t0,                value: 0 },        // zero — dropped
      { ts_ms: t0 + 3_600_000,    value: NaN },      // NaN  — dropped
      { ts_ms: t0 + 86_400_000,   value: 100 },      // good
      { ts_ms: t0 + 2 * 86_400_000, value: 110 },    // good
    ]);
    assert.strictEqual(r.samples_used, 2);
    assert.strictEqual(r.total_delta, 10);
    approxEq(r.rate_per_day, 10.0, 0.001);
  });

  // ── computeContactorScore — phase-2 (cycle rate available) ───────────────
  test("computeContactorScore: cycle_rate=null → phase1 weights, no cycle score", () => {
    const r = computeContactorScore({ stop_count: 1 });
    assert.strictEqual(r.weights_used.phase, "phase1");
    assert.strictEqual(r.breakdown.cycle_score, null);
  });

  test("computeContactorScore: cycle_rate finite → phase2 weights, cycle score present", () => {
    const r = computeContactorScore({ cycle_rate_per_day: 5 });
    assert.strictEqual(r.weights_used.phase, "phase2");
    assert.ok(typeof r.breakdown.cycle_score === "number");
  });

  test("computeContactorScore: cycle_rate below floor (3/day) contributes 0", () => {
    const r = computeContactorScore({ cycle_rate_per_day: 1.5 });
    assert.strictEqual(r.breakdown.cycle_score, 0);
  });

  test("computeContactorScore: cycle_rate at ceil (20/day) → cycle_score=100", () => {
    const r = computeContactorScore({ cycle_rate_per_day: 20 });
    assert.strictEqual(r.breakdown.cycle_score, 100);
  });

  test("computeContactorScore: cycle_rate at midpoint maps linearly", () => {
    // mid = (FLOOR + CEIL) / 2 = (3 + 20) / 2 = 11.5 → score = 50
    const r = computeContactorScore({ cycle_rate_per_day: 11.5 });
    approxEq(r.breakdown.cycle_score, 50, 0.5);
  });

  test("computeContactorScore: phase2 weights sum to 1.0", () => {
    const r = computeContactorScore({ cycle_rate_per_day: 5 });
    const w = r.weights_used.weights;
    const sum = w.stop + w.alarm + w.chatter + w.cycle + w.vac + w.iac;
    approxEq(sum, 1.0, 1e-9);
  });

  test("computeContactorScore: phase2 high cycle alone → mid-aging tier", () => {
    // cycle_rate=20 → cycle_score=100, weighted at 0.15 = 15
    const r = computeContactorScore({ cycle_rate_per_day: 20 });
    approxEq(r.score, 15, 0.05);
    assert.strictEqual(r.tier, "healthy");
  });

  test("computeContactorScore: phase2 max everything → score 100, eol", () => {
    const r = computeContactorScore({
      stop_count: 100,
      alarm_episode_count: 100,
      chatter_count: 100,
      cycle_rate_per_day: 100,
      vac_imbalance_pct: 99,
      iac_imbalance_pct: 99,
    });
    approxEq(r.score, 100, 0.05);
    assert.strictEqual(r.tier, "eol");
  });

  test("correlateWithIgbt: act severity sticks even if later watch rule fires", () => {
    const r = correlateWithIgbt({
      contactor: { chatter_count: 5, stop_count: 1 },
      igbt: { frama_count: 1, imbalance_pct: 8 },
    });
    assert.strictEqual(r.linked, true);
    assert.strictEqual(r.severity, "act");
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  acContactorHealthCore.test.js complete\n");
}

run();
