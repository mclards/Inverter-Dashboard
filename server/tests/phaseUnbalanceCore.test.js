"use strict";

/**
 * phaseUnbalanceCore.test.js — pure-function tests for the Slice κ.8
 * physical-measurement gate on the critical-alarm auto-block.
 *
 *   T1. balanced phases at high power → valid, unbalance_pct ≈ 0
 *   T2. one phase ~30% off the others → valid, unbalance_pct ≈ 30
 *   T3. below MIN_PAC_W → invalid (pac_below_floor)
 *   T4. one phase at noise floor → invalid (phase_below_noise)
 *   T5. outside solar window → invalid (outside_solar_window)
 *   T6. evaluateSustainedUnbalance: <minSustainedSlots consecutive → not sustained
 *   T7. evaluateSustainedUnbalance: ≥minSustainedSlots consecutive → sustained
 *   T8. evaluateSustainedUnbalance: streak broken by an invalid slot → not sustained
 *   T9. empty rows → not sustained, slots_evaluated=0
 */

const assert = require("assert");

const {
  computeUnbalanceFromRow,
  evaluateSustainedUnbalance,
  DEFAULT_UNBALANCE_PCT_THRESHOLD,
  DEFAULT_MIN_SUSTAINED_SLOTS,
  DEFAULT_MIN_IAC_AVG_A,
  DEFAULT_MIN_PAC_W,
} = require("../phaseUnbalance");

function row({ iac1 = 100, iac2 = 100, iac3 = 100, pac_w = 200_000, in_solar = 1 } = {}) {
  return { iac1_a: iac1, iac2_a: iac2, iac3_a: iac3, pac_w, in_solar_window: in_solar };
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  phaseUnbalanceCore.test.js");
  console.log("──────────────────────────────────────────────────────────\n");

  // ── T1: balanced ──────────────────────────────────────────────────
  {
    const r = computeUnbalanceFromRow(row({ iac1: 100, iac2: 100, iac3: 100 }));
    assert.strictEqual(r.valid, true, "T1: balanced row must be valid");
    assert.ok(r.unbalance_pct < 0.01, `T1: balanced ≈ 0 (got ${r.unbalance_pct})`);
    console.log(`  ✓ T1 balanced: unbalance=${r.unbalance_pct.toFixed(3)}%`);
  }

  // ── T2: 30% unbalanced ────────────────────────────────────────────
  {
    // iac = [100, 100, 70]. Iavg=90, (max-min)/avg = 30/90 = 33.3%
    const r = computeUnbalanceFromRow(row({ iac1: 100, iac2: 100, iac3: 70 }));
    assert.strictEqual(r.valid, true, "T2: 30% unbalance must be valid");
    assert.ok(
      r.unbalance_pct >= DEFAULT_UNBALANCE_PCT_THRESHOLD,
      `T2: must clear threshold ${DEFAULT_UNBALANCE_PCT_THRESHOLD} (got ${r.unbalance_pct})`,
    );
    assert.ok(
      Math.abs(r.unbalance_pct - 33.333) < 0.1,
      `T2: expected ≈33.3%, got ${r.unbalance_pct}`,
    );
    console.log(`  ✓ T2 unbalanced 30%: unbalance=${r.unbalance_pct.toFixed(2)}%`);
  }

  // ── T3: low pac ───────────────────────────────────────────────────
  {
    const r = computeUnbalanceFromRow(row({ pac_w: DEFAULT_MIN_PAC_W - 1 }));
    assert.strictEqual(r.valid, false, "T3: low pac must be invalid");
    assert.strictEqual(r.why, "pac_below_floor", `T3: expected pac_below_floor, got ${r.why}`);
    console.log(`  ✓ T3 low pac: rejected with why=${r.why}`);
  }

  // ── T4: noise-floor phase ─────────────────────────────────────────
  {
    const r = computeUnbalanceFromRow(row({ iac1: 0.1, iac2: 100, iac3: 100 }));
    assert.strictEqual(r.valid, false, "T4: phase at noise floor must be invalid");
    assert.strictEqual(r.why, "phase_below_noise", `T4: expected phase_below_noise, got ${r.why}`);
    console.log(`  ✓ T4 noise floor: rejected with why=${r.why}`);
  }

  // ── T5: outside solar window ──────────────────────────────────────
  {
    const r = computeUnbalanceFromRow(row({ in_solar: 0 }));
    assert.strictEqual(r.valid, false, "T5: outside solar window must be invalid");
    assert.strictEqual(r.why, "outside_solar_window", `T5: expected outside_solar_window, got ${r.why}`);
    console.log(`  ✓ T5 outside solar window: rejected with why=${r.why}`);
  }

  // ── T6: <minSustainedSlots ────────────────────────────────────────
  {
    // 1 unbalanced slot, then balanced. With minSustainedSlots=2 (default),
    // not sustained.
    const rows = [
      row({ iac1: 100, iac2: 100, iac3: 70 }), // freshest, unbalanced
      row({ iac1: 100, iac2: 100, iac3: 100 }), // balanced, breaks streak
    ];
    const v = evaluateSustainedUnbalance(rows);
    assert.strictEqual(v.sustained, false, "T6: single unbalanced slot must not be sustained");
    assert.strictEqual(v.slots_over_threshold, 1);
    console.log(`  ✓ T6 streak<min: sustained=false (1 over, min=${DEFAULT_MIN_SUSTAINED_SLOTS})`);
  }

  // ── T7: ≥minSustainedSlots consecutive ────────────────────────────
  {
    const rows = [
      row({ iac1: 100, iac2: 100, iac3: 70 }), // freshest
      row({ iac1: 100, iac2: 100, iac3: 65 }), // older
      row({ iac1: 100, iac2: 100, iac3: 60 }), // older still
    ];
    const v = evaluateSustainedUnbalance(rows);
    assert.strictEqual(v.sustained, true, "T7: 3 consecutive unbalanced slots must be sustained");
    assert.strictEqual(v.slots_over_threshold, 3);
    assert.ok(v.max_pct >= DEFAULT_UNBALANCE_PCT_THRESHOLD, `T7: max_pct must clear threshold`);
    console.log(`  ✓ T7 sustained: ${v.slots_over_threshold} slots, max=${v.max_pct}%`);
  }

  // ── T8: streak broken by invalid slot ─────────────────────────────
  {
    // Freshest is unbalanced, second is invalid (pac too low), third is
    // unbalanced. Streak resets at the invalid slot → only 1 in current
    // streak from the freshest direction → not sustained.
    const rows = [
      row({ iac1: 100, iac2: 100, iac3: 70 }),                    // unbalanced, count
      row({ iac1: 100, iac2: 100, iac3: 70, pac_w: 1000 }),         // invalid (low pac)
      row({ iac1: 100, iac2: 100, iac3: 65 }),                    // unbalanced but past the break
    ];
    const v = evaluateSustainedUnbalance(rows);
    assert.strictEqual(v.sustained, false, "T8: invalid middle slot must break the streak");
    console.log(`  ✓ T8 broken streak: sustained=false`);
  }

  // ── T9: empty rows ────────────────────────────────────────────────
  {
    const v = evaluateSustainedUnbalance([]);
    assert.strictEqual(v.sustained, false);
    assert.strictEqual(v.slots_evaluated, 0);
    assert.strictEqual(v.slots_over_threshold, 0);
    console.log(`  ✓ T9 empty: sustained=false`);
  }

  // ── T10: defaults are the documented Slice κ.8 values ─────────────
  {
    assert.strictEqual(DEFAULT_UNBALANCE_PCT_THRESHOLD, 20, "threshold default = 20%");
    assert.strictEqual(DEFAULT_MIN_SUSTAINED_SLOTS, 2, "sustained slots default = 2");
    assert.strictEqual(DEFAULT_MIN_IAC_AVG_A, 5.0, "min iavg default = 5 A");
    assert.strictEqual(DEFAULT_MIN_PAC_W, 10_000, "min pac default = 10 kW");
    console.log(`  ✓ T10 defaults: thr=${DEFAULT_UNBALANCE_PCT_THRESHOLD}% slots=${DEFAULT_MIN_SUSTAINED_SLOTS} iavg=${DEFAULT_MIN_IAC_AVG_A}A pac=${DEFAULT_MIN_PAC_W}W`);
  }

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  phaseUnbalanceCore.test.js complete\n");
}

run();
