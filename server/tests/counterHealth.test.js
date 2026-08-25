"use strict";

/**
 * v2.9.0 Slice F — counterHealth unit tests.
 *
 * Parametrized matrix covers:
 *   F-T1. rtc_year_valid
 *   F-T2. counter_advancing (active + idle paths)
 *   F-T3. parce_precision_ok (valid + out-of-band ratios)
 *   F-T4. trust_etotal / trust_parce composition
 *   F-T5. classifyCounter quarantine shape
 */

const assert = require("assert");
const {
  rtcYearValid,
  counterAdvancing,
  parcePrecisionOk,
  trustEtotal,
  trustParce,
  classifyCounter,
} = require("../counterHealth");

function run() {
  const serverNow = new Date("2026-04-24T12:00:00Z");

  // ── rtc_year_valid ────────────────────────────────────────────────────────
  assert.equal(
    rtcYearValid(
      { rtc_valid: 1, rtc_ms: Date.UTC(2026, 3, 24, 11, 55, 0) },
      serverNow,
    ),
    true,
    "F-T1a: current year ±0 → valid",
  );
  assert.equal(
    rtcYearValid(
      { rtc_valid: 1, rtc_ms: Date.UTC(2027, 3, 24, 11, 55, 0) },
      serverNow,
    ),
    true,
    "F-T1b: Δ=1 → valid",
  );
  assert.equal(
    rtcYearValid(
      { rtc_valid: 1, rtc_ms: Date.UTC(2047, 4, 11, 17, 0, 0) },
      serverNow,
    ),
    false,
    "F-T1c: 2047 (inv 21/u3) → invalid",
  );
  assert.equal(
    rtcYearValid({ rtc_valid: 0, rtc_ms: null }, serverNow),
    false,
    "F-T1d: rtc_valid=0 → invalid",
  );

  // ── counter_advancing ────────────────────────────────────────────────────
  const base = Date.now();
  const active_advancing = [
    { ts_ms: base - 300_000, etotal_kwh: 1000, parce_kwh: 100, pac_w: 8000 },
    { ts_ms: base - 200_000, etotal_kwh: 1001, parce_kwh: 102, pac_w: 8100 },
    { ts_ms: base - 100_000, etotal_kwh: 1002, parce_kwh: 105, pac_w: 8200 },
    { ts_ms: base,           etotal_kwh: 1003, parce_kwh: 108, pac_w: 8150 },
  ];
  assert.equal(counterAdvancing(active_advancing), true, "F-T2a: active + advancing");

  const active_frozen = [
    { ts_ms: base - 300_000, etotal_kwh: 1000, pac_w: 8000 },
    { ts_ms: base - 200_000, etotal_kwh: 1000, pac_w: 8000 },
    { ts_ms: base - 100_000, etotal_kwh: 1000, pac_w: 8000 },
    { ts_ms: base,           etotal_kwh: 1000, pac_w: 8000 },
  ];
  assert.equal(counterAdvancing(active_frozen), false, "F-T2b: active + frozen");

  const idle_frozen = [
    { ts_ms: base - 300_000, etotal_kwh: 1000, pac_w: 10 },
    { ts_ms: base - 100_000, etotal_kwh: 1000, pac_w: 5 },
    { ts_ms: base,           etotal_kwh: 1000, pac_w: 0 },
  ];
  assert.equal(counterAdvancing(idle_frozen), true, "F-T2c: idle + frozen = OK");

  assert.equal(counterAdvancing([]), true, "F-T2d: empty history → assume OK");
  assert.equal(
    counterAdvancing([{ ts_ms: base, etotal_kwh: 1, pac_w: 5000 }]),
    true,
    "F-T2e: single sample → assume OK",
  );

  // ── parce_precision_ok ───────────────────────────────────────────────────
  const parce_good = [
    { ts_ms: base - 300_000, parce_kwh: 100 },
    { ts_ms: base,           parce_kwh: 108 },
  ];
  assert.equal(
    parcePrecisionOk(parce_good, 8000), // ratio 8/8000 = 0.001 → within band
    true,
    "F-T3a: 1 kWh per 1 kWh integrated",
  );
  const parce_flat = [
    { ts_ms: base - 300_000, parce_kwh: 100 },
    { ts_ms: base,           parce_kwh: 100 },
  ];
  assert.equal(parcePrecisionOk(parce_flat, 8000), false, "F-T3b: flat → false");

  // F-T3c..g — band boundary cases. Band is [0.00050, 0.01100] inclusive.
  // ratio = (last.parce - first.parce) / pacIntegratedWh
  const parce_at_lower = [
    { ts_ms: base - 300_000, parce_kwh: 0 },
    { ts_ms: base,           parce_kwh: 5 },
  ];
  assert.equal(
    parcePrecisionOk(parce_at_lower, 10000), // 5/10000 = 0.00050 — EXACT lower
    true,
    "F-T3c: at lower boundary 0.00050 → valid",
  );
  const parce_below_lower = [
    { ts_ms: base - 300_000, parce_kwh: 0 },
    { ts_ms: base,           parce_kwh: 49 },
  ];
  assert.equal(
    parcePrecisionOk(parce_below_lower, 100000), // 49/100000 = 0.00049
    false,
    "F-T3d: below lower boundary → invalid",
  );
  const parce_at_upper = [
    { ts_ms: base - 300_000, parce_kwh: 0 },
    { ts_ms: base,           parce_kwh: 11 },
  ];
  assert.equal(
    parcePrecisionOk(parce_at_upper, 1000), // 11/1000 = 0.01100 — EXACT upper
    true,
    "F-T3e: at upper boundary 0.01100 → valid",
  );
  const parce_above_upper = [
    { ts_ms: base - 300_000, parce_kwh: 0 },
    { ts_ms: base,           parce_kwh: 1101 },
  ];
  assert.equal(
    parcePrecisionOk(parce_above_upper, 100000), // 1101/100000 = 0.01101
    false,
    "F-T3f: above upper boundary → invalid",
  );

  // F-T3g — null/undefined pacIntegratedWh short-circuits to true (insufficient
  // PAC data to evaluate; treat as "not failing").
  assert.equal(parcePrecisionOk(parce_good, null), true, "F-T3g: null pac → true (early gate)");
  assert.equal(parcePrecisionOk(parce_good, undefined), true, "F-T3h: undefined pac → true");
  assert.equal(parcePrecisionOk(parce_good, 0), true, "F-T3i: zero pac → true");
  assert.equal(parcePrecisionOk(parce_good, -100), true, "F-T3j: negative pac → true");
  assert.equal(parcePrecisionOk([], 8000), true, "F-T3k: empty history → true");
  assert.equal(
    parcePrecisionOk([{ ts_ms: base, parce_kwh: 100 }], 8000),
    true,
    "F-T3l: single sample → true",
  );

  // F-T1e..f — RTC year boundary cases.
  assert.equal(
    rtcYearValid(
      { rtc_valid: 1, rtc_ms: Date.UTC(2025, 0, 1, 0, 0, 0) }, // Δ = -1 → valid
      serverNow,
    ),
    true,
    "F-T1e: Δ=-1 → valid",
  );
  assert.equal(
    rtcYearValid(
      { rtc_valid: 1, rtc_ms: Date.UTC(2028, 0, 1, 0, 0, 0) }, // Δ = +2 → invalid
      serverNow,
    ),
    false,
    "F-T1f: Δ=+2 → invalid",
  );
  assert.equal(
    rtcYearValid(
      { rtc_valid: 1, rtc_ms: 0 }, // 0 → falsy → invalid
      serverNow,
    ),
    false,
    "F-T1g: rtc_ms=0 → invalid",
  );
  assert.equal(
    rtcYearValid(null, serverNow),
    false,
    "F-T1h: null state → invalid",
  );

  // F-T2f — exactly at the idle threshold (pac_w === pacIdleW = 500).
  // counterAdvancing uses `meanPac < pacIdleW` (strict), so meanPac == 500
  // does NOT classify as idle and falls through to the advance check.
  const at_idle_boundary = [
    { ts_ms: base - 300_000, etotal_kwh: 1000, pac_w: 500 },
    { ts_ms: base - 100_000, etotal_kwh: 1000, pac_w: 500 },
    { ts_ms: base,           etotal_kwh: 1000, pac_w: 500 },
  ];
  assert.equal(
    counterAdvancing(at_idle_boundary),
    false,
    "F-T2f: meanPac == 500 (boundary) → NOT idle, frozen counter → false",
  );

  // F-T2g — counter delta is exactly 0 across all samples but PAC is just
  // above the idle threshold. Should report frozen (false).
  const tiny_active_frozen = [
    { ts_ms: base - 300_000, etotal_kwh: 1000, pac_w: 501 },
    { ts_ms: base - 100_000, etotal_kwh: 1000, pac_w: 501 },
    { ts_ms: base,           etotal_kwh: 1000, pac_w: 501 },
  ];
  assert.equal(
    counterAdvancing(tiny_active_frozen),
    false,
    "F-T2g: just above idle, no advance → frozen",
  );

  // ── trust_etotal / trust_parce composition ───────────────────────────────
  const goodState = {
    rtc_valid: 1,
    rtc_ms: Date.UTC(2026, 3, 24, 11, 55, 0),
  };
  assert.equal(trustEtotal(goodState, active_advancing, serverNow), true);
  assert.equal(trustEtotal(goodState, active_frozen, serverNow), false);
  assert.equal(trustParce(goodState, active_advancing, 8000, serverNow), true);
  assert.equal(trustParce(goodState, active_advancing, 800_000, serverNow), false,
    "F-T4: ratio 3/800000 ≈ 3.75e-6 → out of band");

  // ── classifyCounter quarantine shape ─────────────────────────────────────
  const c1 = classifyCounter(goodState, active_advancing, 8000, serverNow);
  assert.equal(c1.quarantined, 0);
  assert.equal(c1.source, "pac_integrated");

  const c2 = classifyCounter(
    { rtc_valid: 1, rtc_ms: Date.UTC(2047, 4, 11, 17, 0, 0) },
    active_frozen, 8000, serverNow,
  );
  assert.equal(c2.quarantined, 1);
  assert.equal(c2.reason, "rtc_invalid");

  const c3 = classifyCounter(goodState, active_frozen, 8000, serverNow);
  assert.equal(c3.quarantined, 1);
  assert.equal(c3.reason, "counter_frozen");

  console.log("counterHealth.test: OK");
}

if (require.main === module) {
  run();
}

module.exports = { run };
