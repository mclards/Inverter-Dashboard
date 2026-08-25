"use strict";

// v2.9.2 regression test for the recovery-seed and bucket spike clamps.
//
// Pure-function tests against classifyRecoveryDelta / classifyBucketInc /
// maxRecoveryDeltaKwhForDt — exercises every documented scenario in
// memory/v292_recovery_seed_clamp.md so a future change to the clamp can't
// silently regress the failure mode that produced the 1.86 MWh spike at
// 06:40 on 2026-04-26.

const assert = require("assert");
// Import directly from the leaf core module — avoids loading better-sqlite3
// transitively through ../poller, so the test runs under stock Node without
// requiring a native rebuild.
const {
  maxRecoveryDeltaKwhForDt,
  classifyRecoveryDelta,
  classifyBucketInc,
  MAX_BUCKET_KWH_PER_INVERTER,
} = require("../pollerClampCore");

function approxEqual(actual, expected, tol = 1e-6, msg = "") {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg} expected ≈${expected} got ${actual} (tol=${tol})`,
  );
}

function run() {
  // ── 1. Physics ceiling — proportional to dtSec with a 1.5 s floor ────
  // INVERTER_MAX_KW=1000, SAFETY=1.5, FRAME_DT_FLOOR_S=1.5
  // Floor case: anything below 1.5s is treated as 1.5s.
  approxEqual(
    maxRecoveryDeltaKwhForDt(0.2),
    (1000 * 1.5 * 1.5) / 3600,
    1e-6,
    "200ms poll uses the 1.5s floor",
  );
  approxEqual(
    maxRecoveryDeltaKwhForDt(1.5),
    (1000 * 1.5 * 1.5) / 3600,
    1e-6,
    "1.5s = floor inflection point",
  );
  approxEqual(
    maxRecoveryDeltaKwhForDt(30),
    (1000 * 30 * 1.5) / 3600,
    1e-6,
    "30s ceiling = 12.5 kWh",
  );
  approxEqual(
    maxRecoveryDeltaKwhForDt(60),
    (1000 * 60 * 1.5) / 3600,
    1e-6,
    "60s Node-stall ceiling = 25 kWh — must accommodate legit progression",
  );
  approxEqual(
    maxRecoveryDeltaKwhForDt(600),
    (1000 * 600 * 1.5) / 3600,
    1e-6,
    "10-min Modbus reconnect ceiling = 250 kWh",
  );
  // Defensive against bogus inputs:
  approxEqual(
    maxRecoveryDeltaKwhForDt(NaN),
    (1000 * 1.5 * 1.5) / 3600,
    1e-6,
    "NaN dtSec falls back to floor",
  );
  approxEqual(
    maxRecoveryDeltaKwhForDt(-5),
    (1000 * 1.5 * 1.5) / 3600,
    1e-6,
    "negative dtSec falls back to floor",
  );

  // ── 2. The 06:40 spike — Python re-seed of 1860 kWh on 200 ms frame ──
  {
    const v = classifyRecoveryDelta(0, 1860, 0.2);
    assert.equal(v.tripped, true, "the canonical 1.86 MWh spike must trip");
    assert.equal(v.appliedDelta, 0, "tripped clamp must drop delta to 0");
    approxEqual(v.rawDelta, 1860, 1e-6, "rawDelta is preserved for reporting");
    approxEqual(
      v.ceilingKwh,
      maxRecoveryDeltaKwhForDt(0.2),
      1e-6,
      "ceiling reflects the 200ms-floor case",
    );
  }

  // ── 3. Mid-day Python restart with stale baseline (1700 kWh jump) ────
  {
    const v = classifyRecoveryDelta(800, 2500, 0.2);
    assert.equal(v.tripped, true, "1700 kWh delta must trip");
    assert.equal(v.appliedDelta, 0);
  }

  // ── 4. Legitimate 60s Node event-loop stall during peak production ──
  // Python kept producing 16.67 kWh while Node was unable to poll.
  // This MUST pass without tripping (false-positive guard rail).
  {
    const v = classifyRecoveryDelta(500, 516.67, 60);
    assert.equal(
      v.tripped,
      false,
      "60s stall during 1 MW production must NOT trip — would lose 17 kWh of legit energy",
    );
    approxEqual(v.appliedDelta, 16.67, 1e-3, "legit delta passes through");
  }

  // ── 5. Even at the absolute max for 60s the clamp tolerates it ──────
  {
    const ceiling60 = maxRecoveryDeltaKwhForDt(60);
    const v = classifyRecoveryDelta(0, ceiling60, 60);
    assert.equal(v.tripped, false, "exact ceiling does not trip (uses >, not >=)");
    approxEqual(v.appliedDelta, ceiling60, 1e-9);
  }
  {
    const v = classifyRecoveryDelta(0, maxRecoveryDeltaKwhForDt(60) + 0.001, 60);
    assert.equal(v.tripped, true, "ceiling + ε trips");
  }

  // ── 6. Python restart that resets kwh_today (decreasing direction) ──
  // Math.max(0, ...) protection still applies — delta is 0, never tripped.
  {
    const v = classifyRecoveryDelta(800, 0, 0.2);
    assert.equal(v.tripped, false, "decreasing pythonKwh is not a spike");
    assert.equal(v.appliedDelta, 0, "decrease is clamped to 0 by Math.max");
    assert.equal(v.rawDelta, 0);
  }

  // ── 7. Cold dawn boot — first frame in pristine state ────────────────
  // prev.pythonKwh starts at the seeded value (initial branch in
  // integratePacToday returns 0 unconditionally), then second frame's
  // delta is small. Simulate the second frame here.
  {
    const v = classifyRecoveryDelta(1500, 1500.05, 0.2);
    assert.equal(v.tripped, false);
    approxEqual(v.appliedDelta, 0.05, 1e-6, "small post-seed delta passes");
  }

  // ── 8. Bucket clamp — defense-in-depth ───────────────────────────────
  {
    const v = classifyBucketInc(50);
    assert.equal(v.tripped, false, "50 kWh inc is well below 100 kWh ceiling");
    assert.equal(v.appliedInc, 50);
    assert.equal(v.overage, 0);
  }
  {
    const v = classifyBucketInc(MAX_BUCKET_KWH_PER_INVERTER);
    assert.equal(v.tripped, false, "exact ceiling does not trip");
    assert.equal(v.appliedInc, MAX_BUCKET_KWH_PER_INVERTER);
  }
  {
    const v = classifyBucketInc(1860);
    assert.equal(v.tripped, true, "1.86 MWh bucket inc must trip");
    assert.equal(v.appliedInc, 0, "tripped bucket writes 0 to energy_5min");
    approxEqual(v.overage, 1860 - MAX_BUCKET_KWH_PER_INVERTER, 1e-6);
    approxEqual(v.rawInc, 1860, 1e-6);
  }
  {
    const v = classifyBucketInc(-5);
    assert.equal(v.rawInc, 0, "negative inc clamped to 0 before ceiling check");
    assert.equal(v.tripped, false);
    assert.equal(v.appliedInc, 0);
  }
  {
    const v = classifyBucketInc(NaN);
    assert.equal(v.rawInc, 0, "NaN inc treated as 0");
    assert.equal(v.tripped, false);
  }

  // ── 9. Cumulative scenario — train of seed jumps re-anchors cleanly ─
  // Simulates the integrator's behaviour over 5 frames after a Python
  // restart at frame 1. integratePacToday() updates prev.pythonKwh = pythonKwh
  // unconditionally (after the verdict), so after the spike trips on frame
  // 1 the next frame's delta is measured from the new baseline.
  {
    let prevPythonKwh = 0;
    let pacTodayInverter = 0;
    const frames = [
      { kwh_python: 1860, dt: 0.2, expectTripped: true,  expectApplied: 0 },
      { kwh_python: 1860.05, dt: 0.2, expectTripped: false, expectApplied: 0.05 },
      { kwh_python: 1860.10, dt: 0.2, expectTripped: false, expectApplied: 0.05 },
      { kwh_python: 1860.20, dt: 0.2, expectTripped: false, expectApplied: 0.10 },
      { kwh_python: 1860.30, dt: 0.2, expectTripped: false, expectApplied: 0.10 },
    ];
    for (const [i, f] of frames.entries()) {
      const v = classifyRecoveryDelta(prevPythonKwh, f.kwh_python, f.dt);
      assert.equal(v.tripped, f.expectTripped, `frame ${i} tripped flag`);
      approxEqual(
        v.appliedDelta,
        f.expectApplied,
        1e-6,
        `frame ${i} appliedDelta`,
      );
      pacTodayInverter += v.appliedDelta;
      prevPythonKwh = f.kwh_python; // mirrors integratePacToday's re-anchor
    }
    approxEqual(
      pacTodayInverter,
      0.30,
      1e-6,
      "cumulative pacTodayByInverter after spike + 4 normal frames = 0.30 kWh (only post-anchor energy retained)",
    );
  }

  // ── 10. Long Modbus reconnect — bucket clamp catches what frame clamp let through ──
  // 10-minute reconnect on a 1 MW chain → ~167 kWh delta, dt=600s.
  // Frame ceiling at 600s = 250 kWh → frame clamp does NOT trip.
  // But that 167 kWh would land in one 5-min bucket → bucket clamp catches it.
  {
    const frameVerdict = classifyRecoveryDelta(100, 267, 600);
    assert.equal(frameVerdict.tripped, false, "10-min reconnect passes frame clamp");
    approxEqual(frameVerdict.appliedDelta, 167, 1e-6);

    const bucketVerdict = classifyBucketInc(167);
    assert.equal(bucketVerdict.tripped, true, "but bucket clamp catches the 5-min dump");
    assert.equal(bucketVerdict.appliedInc, 0);
  }

  // Helper: pad a preceding-slots array with leading non-zero values to
  // exceed the WARM_UP_SLOTS threshold. Lets us test the gap-detection
  // logic without each scenario re-asserting the warm-up gate.
  function fullHistory(...tail) {
    const filler = Array(12 - tail.length).fill(50);
    return [...filler, ...tail];
  }

  // ── 11. Operator's scenario: 6:30 slot after 6:05–6:25 zeros ─────────
  // 06:00 had real production (50 kWh). Then 06:05–06:25 were zeros (5 slots
  // = 25 min outage). At 06:30, the slot's value is "too large" — the
  // contextual rule must recognize this as catch-up backfill from the gap
  // even when the value is BELOW the 100 kWh physical ceiling.
  //
  // precedingSlots ends with [..., 50, 0, 0, 0, 0, 0]; pre-padded with
  // earlier production so the warm-up gate passes (12-slot history).
  // Current slot at 06:30 = 70 kWh — below physical ceiling but obviously catch-up.
  {
    const precedingSlots = fullHistory(50, 0, 0, 0, 0, 0);
    const v = classifyBucketInc({ rawInc: 70, precedingSlots });
    assert.equal(v.tripped, true, "70 kWh after 25-min gap must trip via context");
    assert.equal(v.reason, "gap_backfill", "reason should identify the gap");
    assert.equal(v.appliedInc, 0);
    assert.equal(v.consecutiveZeros, 5);
    assert.equal(v.gapMinutes, 25);
    assert.equal(v.inWarmUp, false);
  }

  // ── 12. Same gap but small slot value — passes through ────────────────
  // 25-min gap then 06:30 = 5 kWh (under POST_GAP_KWH_THRESHOLD=30) means
  // the inverter just came back and is producing a tiny amount in the slot.
  // No clamp — could be legit ramp-up.
  {
    const precedingSlots = fullHistory(50, 0, 0, 0, 0, 0);
    const v = classifyBucketInc({ rawInc: 5, precedingSlots });
    assert.equal(v.tripped, false, "small post-gap value passes (could be legit ramp)");
    assert.equal(v.appliedInc, 5);
  }

  // ── 13. Dawn case — preceding zeros but no production further back ────
  // First non-zero slot of the day. precedingSlots = [0, 0, ..., 0]
  // (all nighttime zeros). foundNonZero = false → NOT a gap → no clamp.
  // The first morning slot can be any size up to physical ceiling.
  {
    const precedingSlots = Array(12).fill(0);
    const v = classifyBucketInc({ rawInc: 40, precedingSlots });
    assert.equal(v.tripped, false, "first non-zero slot of day must NOT trip — that's dawn, not a gap");
    assert.equal(v.appliedInc, 40);
  }

  // ── 14. Brief 1-2 slot blip — NOT a gap ──────────────────────────────
  // Single missed poll cycle isn't an outage. Sporadic 0s without 4+ consecutive.
  {
    const precedingSlots = fullHistory(50, 0, 50, 0, 50, 0);
    const v = classifyBucketInc({ rawInc: 60, precedingSlots });
    assert.equal(v.tripped, false, "1-slot intermittent zeros are not a gap");
    assert.equal(v.appliedInc, 60);
  }

  // ── 15. 3-slot gap — exactly at the boundary (< 4 = no trip) ─────────
  // CONSECUTIVE_ZEROS_FOR_GAP = 4, so 3 zeros must NOT trip yet.
  {
    const precedingSlots = fullHistory(50, 50, 50, 0, 0, 0);
    const v = classifyBucketInc({ rawInc: 60, precedingSlots });
    assert.equal(v.tripped, false, "3 consecutive zeros below the 4-zero threshold");
    assert.equal(v.appliedInc, 60);
  }

  // ── 16. 4-slot gap — exactly at the boundary (≥ 4 = trip when value > 30) ──
  {
    const precedingSlots = fullHistory(50, 50, 0, 0, 0, 0);
    const v = classifyBucketInc({ rawInc: 60, precedingSlots });
    assert.equal(v.tripped, true, "4 consecutive zeros = real gap");
    assert.equal(v.reason, "gap_backfill");
    assert.equal(v.consecutiveZeros, 4);
    assert.equal(v.gapMinutes, 20);
    assert.equal(v.appliedInc, 0);
  }

  // ── 17. Physical ceiling beats contextual rule ───────────────────────
  // Even a clean (no gap) 1860 kWh bucket trips via physical ceiling.
  // Reason should be "physical_ceiling" so audit log distinguishes the case.
  {
    const precedingSlots = fullHistory(60, 65, 70, 75, 80, 80);
    const v = classifyBucketInc({ rawInc: 1860, precedingSlots });
    assert.equal(v.tripped, true);
    assert.equal(v.reason, "physical_ceiling", "physical ceiling wins over context check");
    assert.equal(v.appliedInc, 0);
  }

  // ── 18. Backward compatibility — single-arg form still works ─────────
  {
    const v = classifyBucketInc(50);
    assert.equal(v.tripped, false);
    assert.equal(v.appliedInc, 50);
  }
  {
    const v = classifyBucketInc(1860);
    assert.equal(v.tripped, true, "physical ceiling still works in single-arg form");
    assert.equal(v.reason, "physical_ceiling");
  }

  // ── 19. Warm-up gate — empty/short history disables contextual rule ──
  // Operator requirement: "wait for at least 1 hour of normal reading
  // before deciding accurately." Until the buffer holds WARM_UP_SLOTS (12)
  // entries, the contextual gap rule is dormant — only physical ceiling
  // applies. Per-frame clamp upstream still catches recovery seeds.
  {
    // Same gap pattern that would normally trip — but only 6 slots of history
    const precedingSlots = [50, 0, 0, 0, 0, 0];
    const v = classifyBucketInc({ rawInc: 70, precedingSlots });
    assert.equal(v.tripped, false, "warm-up: short history disables contextual rule");
    assert.equal(v.inWarmUp, true);
    assert.equal(v.historyDepth, 6);
    assert.equal(v.appliedInc, 70);
  }

  // ── 20. Warm-up gate — exactly at threshold (12 entries = active) ────
  {
    const precedingSlots = [50, 50, 50, 50, 50, 50, 50, 0, 0, 0, 0, 0];
    const v = classifyBucketInc({ rawInc: 70, precedingSlots });
    assert.equal(v.tripped, true, "warm-up complete at 12 entries — rule activates");
    assert.equal(v.inWarmUp, false);
    assert.equal(v.historyDepth, 12);
    assert.equal(v.reason, "gap_backfill");
  }

  // ── 21. Warm-up gate — physical ceiling still fires during warm-up ───
  // Even with no history, a 1860 kWh bucket still trips via physical ceiling.
  {
    const v = classifyBucketInc({ rawInc: 1860, precedingSlots: [] });
    assert.equal(v.tripped, true, "physical ceiling fires regardless of warm-up");
    assert.equal(v.reason, "physical_ceiling");
    assert.equal(v.appliedInc, 0);
  }

  // ── 22. Warm-up gate — short history with no gap pattern passes ──────
  // 6 slots of clean production data, no gap → small/medium current slot
  // passes (would have passed the contextual rule too even with full history).
  {
    const precedingSlots = [50, 55, 60, 65, 70, 75];
    const v = classifyBucketInc({ rawInc: 80, precedingSlots });
    assert.equal(v.tripped, false);
    assert.equal(v.inWarmUp, true);
    assert.equal(v.appliedInc, 80);
  }

  // ── 23. Per-inverter ceiling — 2-unit inverter has 50 kWh ceiling ────
  // The plant has inverters with 2–4 units. A 2-unit inverter's max sustained
  // output is ~500 kW = 41.7 kWh/slot. With 1.2 safety, ceiling = 50 kWh.
  // The default 100 kWh ceiling is too lenient for 2-unit inverters.
  {
    // 60 kWh on a 2-unit inverter trips physical ceiling (50 kWh)
    const v = classifyBucketInc({ rawInc: 60, unitsCount: 2 });
    assert.equal(v.tripped, true, "60 kWh exceeds 2-unit ceiling of 50 kWh");
    assert.equal(v.reason, "physical_ceiling");
    approxEqual(v.ceilingKwh, 50, 1e-9, "2-unit ceiling = 50 kWh exact");
    assert.equal(v.unitsCount, 2);
    assert.equal(v.ratedKw, 500);
    assert.equal(v.appliedInc, 0);
  }
  {
    // Same 60 kWh on a 4-unit inverter passes (well below 100 kWh ceiling)
    const v = classifyBucketInc({ rawInc: 60, unitsCount: 4 });
    assert.equal(v.tripped, false, "60 kWh fits within 4-unit ceiling of 100");
    assert.equal(v.appliedInc, 60);
    approxEqual(v.ceilingKwh, 100, 1e-9, "4-unit ceiling = 100 kWh exact");
  }

  // ── 24. Per-inverter ceiling — 3-unit inverter has 75 kWh ceiling ────
  {
    const v = classifyBucketInc({ rawInc: 80, unitsCount: 3 });
    assert.equal(v.tripped, true, "80 kWh exceeds 3-unit ceiling of 75 kWh");
    assert.equal(v.reason, "physical_ceiling");
    approxEqual(v.ceilingKwh, 75, 1e-9, "3-unit ceiling = 75 kWh exact");
    assert.equal(v.unitsCount, 3);
    assert.equal(v.ratedKw, 750);
  }
  {
    const v = classifyBucketInc({ rawInc: 70, unitsCount: 3 });
    assert.equal(v.tripped, false, "70 kWh fits within 3-unit ceiling of 75");
    assert.equal(v.appliedInc, 70);
  }

  // ── 25. Per-inverter ceiling — 1-unit inverter has 25 kWh ceiling ────
  {
    const v = classifyBucketInc({ rawInc: 30, unitsCount: 1 });
    assert.equal(v.tripped, true, "30 kWh exceeds 1-unit ceiling of 25 kWh");
    assert.equal(v.reason, "physical_ceiling");
    approxEqual(v.ceilingKwh, 25, 1e-9, "1-unit ceiling = 25 kWh exact");
    assert.equal(v.unitsCount, 1);
    assert.equal(v.ratedKw, 250);
  }

  // ── 26. Per-inverter gap threshold also scales with unit count ───────
  // 2-unit inverter post-gap threshold = 500 × 5/60 × 0.4 = 16.67 kWh.
  // After a 25-min gap, 20 kWh on a 2-unit inverter trips the gap rule.
  {
    const precedingSlots = Array(7).fill(20).concat([0, 0, 0, 0, 0]);
    const v = classifyBucketInc({
      rawInc: 20,
      precedingSlots,
      unitsCount: 2,
    });
    assert.equal(v.tripped, true, "20 kWh after gap exceeds 2-unit gap threshold");
    assert.equal(v.reason, "gap_backfill");
    approxEqual(v.ceilingKwh, (500 * 5 * 0.4) / 60, 1e-9, "2-unit gap threshold ≈ 16.67 kWh");
  }

  // ── 27. Defensive: out-of-range unitsCount falls back to clamping ────
  // Project's hardware bounds are 1–4 units. Out-of-range values should
  // clamp into that range so the formula never produces a degenerate ceiling.
  {
    const v = classifyBucketInc({ rawInc: 10, unitsCount: 0 });
    assert.equal(v.unitsCount, 1, "unitsCount=0 clamped to 1");
    assert.equal(v.ratedKw, 250);
  }
  {
    const v = classifyBucketInc({ rawInc: 10, unitsCount: 99 });
    assert.equal(v.unitsCount, 4, "unitsCount=99 clamped to 4");
    assert.equal(v.ratedKw, 1000);
  }
  {
    const v = classifyBucketInc({ rawInc: 10, unitsCount: NaN });
    assert.equal(v.unitsCount, 4, "NaN unitsCount falls back to default 4");
  }

  // ── 28. Default behaviour preserved (no unitsCount → 4 units, 100 kWh) ──
  // Single-arg form and missing unitsCount must continue to use the 4-unit
  // ceiling so existing callers and tests are unaffected.
  {
    const v = classifyBucketInc({ rawInc: 99, precedingSlots: [] });
    assert.equal(v.tripped, false, "99 kWh fits within default 4-unit ceiling");
    assert.equal(v.unitsCount, 4);
  }

  console.log("recoverySeedClamp.test.js: PASS");
}

run();
