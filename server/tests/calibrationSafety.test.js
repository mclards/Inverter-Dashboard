"use strict";

/**
 * TrinPM20 per-offset write-safety gate tests.
 *
 * Plan: plans/2026-05-12-inverter-calibration-tool.md §2.4
 *
 * Locks the contract that:
 *   • Fesc_ipv (offset 87) is gated to the 60 % consign band
 *   • Reactive X1Y1 (91, 92) requires 20 ± 5 % Pn (consign target)
 *   • Reactive X2Y2 (93, 94) requires 70 ± 5 % Pn (consign target)
 *   • Per. Vacio (offset 90) requires the 0 % consign band — inverter NOT
 *     generating (corrected 2026-05-17: was wrongly state-only/display-only)
 *   • Any write refuses while the inverter is in ERROR / BLOCKED / GRID FAULT
 *     phase, or when the state register couldn't be read at all.
 *   • Offsets 81-86 / 88-89 are state-gated only (Pac/Pn band is not enforced).
 */

const assert = require("assert");
const calibrationSafety = require("../calibrationSafety");

const { evaluateWriteSafety, buildWriteSafetyMap } = calibrationSafety;

// Helper — build a "live" snapshot stub mirroring what
// services/inverter_engine.py emits.
function makeLive(overrides) {
  return Object.assign({
    state_raw: 0x0002,        // phase=2 (grid-connected), flags=0
    state_phase: 2,
    state_stop: 0,
    state_blocked: 0,
    state_grid_fault: 0,
    pac_w: 200000,             // 200 kW
    nominal_power_w: 250000,   // 250 kW
    pct_of_pn: 80.0,
  }, overrides || {});
}

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

function run() {
  // ── State gate (applies to all 14 writable offsets) ────────────────────

  test("state: refuses when state register is unreadable", () => {
    const v = evaluateWriteSafety(81, makeLive({ state_raw: null, state_phase: null }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "block");
    assert.ok(/unreadable/i.test(v.reason), `reason: ${v.reason}`);
  });

  test("state: refuses when phase = error (3)", () => {
    const v = evaluateWriteSafety(81, makeLive({ state_phase: 3 }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "block");
    assert.ok(/error/i.test(v.reason));
  });

  test("state: refuses when blocked flag set", () => {
    const v = evaluateWriteSafety(81, makeLive({ state_blocked: 1 }));
    assert.strictEqual(v.ok, false);
    assert.ok(/blocked/i.test(v.reason));
  });

  test("state: refuses on grid fault flag", () => {
    const v = evaluateWriteSafety(81, makeLive({ state_grid_fault: 1 }));
    assert.strictEqual(v.ok, false);
    assert.ok(/grid fault/i.test(v.reason));
  });

  // Contract change (2026-05-16, operator feedback): scale-factor
  // calibration is legitimately done OFF-GRID. "Not grid-connected" must
  // WARN, not BLOCK — so a plain Vac/Iac offset still writes without the
  // operator having to arm the Force-bypass on every single write. Only
  // genuinely unsafe states (unreadable / ERROR / BLOCKED / GRID FAULT)
  // remain a hard block (covered by the tests above).
  test("state: phase != grid-connected (initial=0) warns, does NOT block", () => {
    const v = evaluateWriteSafety(81, makeLive({ state_phase: 0 }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "warn");
    assert.ok(/grid-connected/i.test(v.reason));
  });

  test("state: not-grid-connected warn is non-blocking for Vac/Iac scale", () => {
    // Server only refuses on severity === "block" (checkTrinPmSafetyGates),
    // so a warn verdict means the write proceeds with no Force toggle.
    for (const off of [81, 82, 83, 84, 85, 86]) {
      const v = evaluateWriteSafety(off, makeLive({ state_phase: 1 }));
      assert.strictEqual(v.severity, "warn", `offset ${off}`);
    }
  });

  test("state: passes for grid-connected non-faulted inverter", () => {
    const v = evaluateWriteSafety(81, makeLive());
    assert.strictEqual(v.ok, true);
  });

  // ── Fesc_ipv (offset 87) — Pac/Pn ≈ 60 % consign band (TrinPM20 script) ──
  // Band gate, NOT a minimum: both too-low and too-high are wrong consign
  // targets. Operator directive 2026-05-17 — follow the video (60 %).

  test("Fesc_ipv: refuses well below the 60 % band (40 %)", () => {
    const v = evaluateWriteSafety(87, makeLive({ pac_w: 100000, pct_of_pn: 40.0 }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "block");
    assert.ok(/60/.test(v.reason));
    assert.deepStrictEqual(v.required.pct_of_pn, [55.0, 65.0]);
  });

  test("Fesc_ipv: allows at exactly 60 % Pn (consign target)", () => {
    const v = evaluateWriteSafety(87, makeLive({ pct_of_pn: 60.0 }));
    assert.strictEqual(v.ok, true);
  });

  test("Fesc_ipv: allows across the 55–65 % band", () => {
    for (const pct of [55, 58, 60, 62, 65]) {
      assert.strictEqual(evaluateWriteSafety(87, makeLive({ pct_of_pn: pct })).ok, true,
        `pct ${pct} should pass`);
    }
  });

  test("Fesc_ipv: refuses ABOVE the band (70 % is now the wrong target)", () => {
    const v = evaluateWriteSafety(87, makeLive({ pct_of_pn: 70.0 }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "block");
  });

  test("Fesc_ipv: refuses just outside the 65 % upper bound", () => {
    assert.strictEqual(evaluateWriteSafety(87, makeLive({ pct_of_pn: 66.0 })).ok, false);
  });

  test("Fesc_ipv: refuses when nominal power read failed (pct_of_pn null)", () => {
    const v = evaluateWriteSafety(87, makeLive({
      pac_w: 200000, nominal_power_w: null, pct_of_pn: null,
    }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "warn");
  });

  // ── Reactive X1/Y1 (offsets 91, 92) — Pac/Pn ≈ 20 % gate ────────────────

  test("Reactive X1Y1: refuses at 0 % Pn (consign not engaged)", () => {
    const v = evaluateWriteSafety(91, makeLive({ pct_of_pn: 0.5 }));
    assert.strictEqual(v.ok, false);
    assert.ok(/X1Y1/.test(v.reason));
  });

  test("Reactive X1Y1: allows in 15-25 % Pn band", () => {
    for (const pct of [15, 18, 20, 22, 25]) {
      const v = evaluateWriteSafety(91, makeLive({ pct_of_pn: pct }));
      assert.strictEqual(v.ok, true, `pct ${pct} should pass`);
    }
  });

  test("Reactive X1Y1: refuses just outside 25 % upper bound", () => {
    const v = evaluateWriteSafety(91, makeLive({ pct_of_pn: 26.0 }));
    assert.strictEqual(v.ok, false);
  });

  test("Reactive Y1 (offset 92) same gate as X1", () => {
    assert.strictEqual(evaluateWriteSafety(92, makeLive({ pct_of_pn: 20 })).ok, true);
    assert.strictEqual(evaluateWriteSafety(92, makeLive({ pct_of_pn: 80 })).ok, false);
  });

  // ── Reactive X2/Y2 (offsets 93, 94) — Pac/Pn ≈ 70 % gate ────────────────

  test("Reactive X2Y2: refuses at 20 % Pn (wrong consign target)", () => {
    const v = evaluateWriteSafety(93, makeLive({ pct_of_pn: 20.0 }));
    assert.strictEqual(v.ok, false);
    assert.ok(/X2Y2/.test(v.reason));
  });

  test("Reactive X2Y2: allows in 65-75 % Pn band", () => {
    for (const pct of [65, 68, 70, 72, 75]) {
      const v = evaluateWriteSafety(93, makeLive({ pct_of_pn: pct }));
      assert.strictEqual(v.ok, true, `pct ${pct} should pass`);
    }
  });

  test("Reactive Y2 (offset 94) same gate as X2", () => {
    assert.strictEqual(evaluateWriteSafety(94, makeLive({ pct_of_pn: 70 })).ok, true);
    assert.strictEqual(evaluateWriteSafety(94, makeLive({ pct_of_pn: 20 })).ok, false);
  });

  // ── Voltage / generic scale factors (81-86, 88-89) — state-only ───────

  test("Fesc_vac_1 (81): no Pac/Pn band — passes at any pct when state OK", () => {
    for (const pct of [0.5, 20, 50, 99]) {
      const v = evaluateWriteSafety(81, makeLive({ pct_of_pn: pct }));
      assert.strictEqual(v.ok, true, `pct ${pct} should pass for offset 81`);
    }
  });

  // ── Per. Vacio (offset 90) — 0 % consign band (NOT generating) ─────────
  // Corrected 2026-05-17: offset 90 is editable (ISM CfgTrifAU writable
  // scale factor), calibrated with the inverter not generating. It is a
  // 0 %-band gate, NOT state-only, and NOT a non-bypassable refusal.

  test("comp_per_vacio (90): allows at 0 % Pn (inverter not generating)", () => {
    const v = evaluateWriteSafety(90, makeLive({ pct_of_pn: 0 }));
    assert.strictEqual(v.ok, true);
  });

  test("comp_per_vacio (90): allows within the 0 % band (incl. slight -ve no-load)", () => {
    for (const pct of [-3, 0, 4.9]) {
      const v = evaluateWriteSafety(90, makeLive({ pct_of_pn: pct }));
      assert.strictEqual(v.ok, true, `pct ${pct} should pass for offset 90`);
    }
  });

  test("comp_per_vacio (90): BLOCKS when generating (50 % — wrong consign)", () => {
    const v = evaluateWriteSafety(90, makeLive({ pct_of_pn: 50 }));
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.severity, "block");
    assert.ok(/not generating|0 %/i.test(v.reason), `reason: ${v.reason}`);
  });

  test("comp_per_vacio (90): blocks just above the band (e.g. 6 %)", () => {
    assert.strictEqual(evaluateWriteSafety(90, makeLive({ pct_of_pn: 6 })).ok, false);
  });

  // ── buildWriteSafetyMap — every offset surfaces a verdict ──────────────

  test("buildWriteSafetyMap: returns one verdict per requested offset", () => {
    const live = makeLive({ pct_of_pn: 60 });
    const m = buildWriteSafetyMap(live, [81, 87, 91, 93]);
    assert.deepStrictEqual(Object.keys(m).map(Number).sort((a,b)=>a-b), [81, 87, 91, 93]);
    assert.strictEqual(m[81].ok, true,  "Vac scale passes regardless of pct");
    assert.strictEqual(m[87].ok, true,  "Fesc_ipv ALLOWS at 60 % (consign target)");
    assert.strictEqual(m[91].ok, false, "X1Y1 blocks at 60 % (need 20 ± 5)");
    assert.strictEqual(m[93].ok, false, "X2Y2 blocks at 60 % (need 70 ± 5)");
  });

  test("buildWriteSafetyMap: state error blocks everything", () => {
    const live = makeLive({ state_phase: 3 });
    const m = buildWriteSafetyMap(live, [81, 87, 91, 93]);
    for (const off of [81, 87, 91, 93]) {
      assert.strictEqual(m[off].ok, false, `offset ${off} should block on error state`);
      assert.ok(/error/i.test(m[off].reason));
    }
  });

  console.log("calibrationSafety.test.js: done");
}

run();
