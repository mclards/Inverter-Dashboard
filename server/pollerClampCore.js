"use strict";

// v2.9.2 — Pure recovery-seed and bucket spike clamps used by poller.js.
//
// Extracted from poller.js so the unit tests can exercise the math without
// loading better-sqlite3 / the rest of the poller's transitive dependencies.
// poller.js imports from this module; this module imports nothing.
//
// Background and rationale: see memory/v292_recovery_seed_clamp.md and
// CLAUDE.md "Hardware Counter Recovery + Clock Sync (v2.9.0)".

// Per-Ingeteam-INGECON unit physical max — held at 250 for exact integer
// clamp math (4 × 250 × 5 × 1.2 / 60 = 100 kWh exact). The official Ingeteam
// "Plantilla Parámetros" template Pmax per stage is 249.41 kW; rounding the
// safety ceiling up to 250 keeps the clamp conservative (legitimate readings
// can never exceed Pmax) and preserves the test-suite's exact-25/50/75/100
// kWh assertions. One inverter = 1–4 units; per-bucket ceiling scales linearly.
const UNIT_RATED_KW = 250;

// 1 MW physical max for a default 4-unit inverter (legacy alias kept for the
// per-frame Python-delta ceiling math, which is conservative enough that
// scaling per inverter buys little).
const INVERTER_MAX_KW = 4 * UNIT_RATED_KW;

// Headroom over physical max for the per-frame ceiling.
const RECOVERY_CLAMP_SAFETY = 1.5;

// Floor so 200 ms polls aren't clamped at near-zero.
const FRAME_DT_FLOOR_S = 1.5;

// Per-bucket physical ceiling math:
//   ceilingKwh   = unitsCount × UNIT_RATED_KW × (5/60) × BUCKET_CEILING_SAFETY
//   threshold    = unitsCount × UNIT_RATED_KW × (5/60) × POST_GAP_FRACTION
// Reformulated to keep all constants integer-friendly so 4-unit math
// produces exact 100 kWh ceiling without floating-point error:
//   ceilingKwh   = (units × UNIT_RATED_KW × 5 × 1.2) / 60 = units × 25
//   threshold    = (units × UNIT_RATED_KW × 5 × 0.4) / 60 = units × (25/3) ≈ units × 8.33
const BUCKET_CEILING_SAFETY = 1.2;     // 20% headroom over physical max
const POST_GAP_FRACTION = 0.4;         // 40% of physical max ≈ catch-up threshold

// Default ceiling reported when no unit-count override is provided (= 4 units).
// Backward-compatibility constant retained for callers that read it directly
// (e.g. tests asserting "exact ceiling does not trip" with 100 kWh).
const MAX_BUCKET_KWH_PER_INVERTER = 100;

function bucketCeilingsForUnits(unitsCount) {
  // Defensive normalization:
  //   • undefined / null / NaN  → 4 (default — no value specified)
  //   • explicit numeric value  → clamp into the project's 1..4 hardware bounds
  // This guarantees a positive ceiling for every code path while still
  // honouring legitimate 1/2/3-unit configurations.
  const raw = Number(unitsCount);
  let units;
  if (unitsCount === undefined || unitsCount === null || !Number.isFinite(raw)) {
    units = 4;
  } else {
    units = Math.max(1, Math.min(4, Math.trunc(raw)));
  }
  // Integer-first ordering keeps 4-unit math exact (no floating-point drift):
  //   (4 × 250 × 5 × 1.2) / 60  =  6000 / 60 = 100   ← exact
  //   (4 × 250 × 5 × 0.4) / 60  =  2000 / 60 = 33.33 (rounded)
  const physicalCeiling =
    (units * UNIT_RATED_KW * 5 * BUCKET_CEILING_SAFETY) / 60;
  const postGapThreshold =
    (units * UNIT_RATED_KW * 5 * POST_GAP_FRACTION) / 60;
  return {
    unitsCount: units,
    ratedKw: units * UNIT_RATED_KW,
    physicalCeiling,
    postGapThreshold,
  };
}

// Contextual gap-backfill detection.
//
// Operator's mental model (correct one): if the preceding slots are zeros for
// long enough that they represent a real crash/disconnect, then any non-trivial
// energy in the slot at the recovery moment is "catch-up" — energy that should
// be distributed across the gap window but is instead being dumped into one slot.
//
// Look back over the last RECENT_SLOTS_WINDOW slots for this inverter.
// Count consecutive zero slots immediately preceding the current slot. If
// we find ≥ CONSECUTIVE_ZEROS_FOR_GAP zeros AND a non-zero slot exists
// further back (so we know the inverter was producing before the gap, not
// just nighttime/dawn), this is a gap. After a gap, any kwh_inc above
// POST_GAP_KWH_THRESHOLD is treated as backfill and clamped to 0.
//
// "Non-zero slot must exist further back" prevents false positives during
// dawn (when preceding slots are zero because the sun hadn't risen yet —
// not a gap). The first non-zero slot of the day passes through cleanly.
//
// Warm-up rule: the contextual gap-backfill check requires WARM_UP_SLOTS slots
// of history before it activates ("1 hour of normal reading" — operator's
// intent). When the ring buffer holds fewer than WARM_UP_SLOTS entries, only
// Rule 1 (physical ceiling) applies. This prevents low-confidence decisions
// in the first hour after Node start while the per-frame clamp + physical
// ceiling still protect against catastrophic spikes.
const RECENT_SLOTS_WINDOW = 12;         // 1-hour lookback (12 slots × 5 min)
const WARM_UP_SLOTS = 12;               // contextual rule activates once buffer is full
const CONSECUTIVE_ZEROS_FOR_GAP = 4;    // ≥ 20 min of zeros = real outage signal
const POST_GAP_KWH_THRESHOLD = 30;      // any value > 30 kWh after gap is suspect catch-up

// dt-aware ceiling for the per-frame Python-delta clamp.
//
// Numerical sanity (INVERTER_MAX_KW=1000, SAFETY=1.5):
//   dtSec = 0.2  → ceiling =  0.625 kWh   (typical poll; 1860 kWh seed × 2978× over)
//   dtSec = 1.5  → ceiling =  0.625 kWh   (floored)
//   dtSec = 30   → ceiling = 12.5  kWh    (MAX_PAC_DT_S boundary)
//   dtSec = 60   → ceiling = 25    kWh    (60 s Node stall passes legit progression)
//   dtSec = 600  → ceiling = 250   kWh    (10 min reconnect — bucket clamp still catches single-slot dump)
function maxRecoveryDeltaKwhForDt(dtSec) {
  const safeDt = Math.max(FRAME_DT_FLOOR_S, Number(dtSec) || 0);
  return (INVERTER_MAX_KW * safeDt * RECOVERY_CLAMP_SAFETY) / 3600;
}

// Pure classifier for the per-frame recovery-seed clamp.
//   rawDelta     — what pythonDelta would have been without the clamp
//   ceilingKwh   — the dt-aware ceiling that was applied
//   tripped      — true if rawDelta exceeded the ceiling
//   appliedDelta — what to actually add to the integrator (0 when tripped)
function classifyRecoveryDelta(prevPythonKwh, pythonKwh, dtSec) {
  const rawDelta = Math.max(
    0,
    (Number(pythonKwh) || 0) - (Number(prevPythonKwh) || 0),
  );
  const ceilingKwh = maxRecoveryDeltaKwhForDt(dtSec);
  const tripped = rawDelta > ceilingKwh;
  return {
    rawDelta,
    ceilingKwh,
    tripped,
    appliedDelta: tripped ? 0 : rawDelta,
  };
}

// Pure classifier for the per-bucket defense-in-depth clamp.
// Two-rule decision:
//   1. Physical ceiling — hard cap based on the inverter's CONFIGURED unit
//      count (1–4). 4-unit inverter → 100 kWh; 2-unit inverter → 50 kWh.
//   2. Contextual gap-backfill — preceding slots tell us this is catch-up.
//
// Accepts either signature for backward compatibility:
//   classifyBucketInc(numericRawInc)                                          — defaults to 4 units, no context
//   classifyBucketInc({ rawInc, precedingSlots: [...], unitsCount: 2 })       — full check
//
// `precedingSlots` is the ordered list of last N kwh_inc values for THIS
// inverter (oldest → newest), excluding the current slot being classified.
// `unitsCount` is the inverter's configured unit count (1–4); defaults to 4
// when not specified. The physical ceiling and gap threshold scale with it.
function classifyBucketInc(arg) {
  let rawInc;
  let precedingSlots;
  let unitsCount;
  if (arg !== null && typeof arg === "object" && !Array.isArray(arg)) {
    rawInc = arg.rawInc;
    precedingSlots = arg.precedingSlots;
    unitsCount = arg.unitsCount;
  } else {
    rawInc = arg;
    precedingSlots = [];
    unitsCount = undefined;
  }

  const inc = Math.max(0, Number(rawInc) || 0);
  const ceilings = bucketCeilingsForUnits(unitsCount);

  // Rule 1 — hard physical ceiling, scaled per inverter's unit count.
  // Always wins regardless of context.
  if (inc > ceilings.physicalCeiling) {
    return {
      rawInc: inc,
      ceilingKwh: ceilings.physicalCeiling,
      tripped: true,
      reason: "physical_ceiling",
      overage: inc - ceilings.physicalCeiling,
      appliedInc: 0,
      consecutiveZeros: 0,
      gapMinutes: 0,
      unitsCount: ceilings.unitsCount,
      ratedKw: ceilings.ratedKw,
    };
  }

  // Rule 2 — contextual gap-backfill detection.
  //
  // Warm-up gate: the rule only activates once we have WARM_UP_SLOTS
  // (= 1 hour) of history for this inverter. While history is shorter,
  // we don't have the context to make an accurate contextual decision —
  // only Rule 1 (physical ceiling) protects, plus the per-frame clamp
  // upstream which doesn't need history.
  const recent = Array.isArray(precedingSlots) ? precedingSlots : [];
  const inWarmUp = recent.length < WARM_UP_SLOTS;

  if (inWarmUp) {
    return {
      rawInc: inc,
      ceilingKwh: ceilings.physicalCeiling,
      tripped: false,
      reason: "",
      overage: 0,
      appliedInc: inc,
      consecutiveZeros: 0,
      gapMinutes: 0,
      inWarmUp: true,
      historyDepth: recent.length,
      unitsCount: ceilings.unitsCount,
      ratedKw: ceilings.ratedKw,
    };
  }

  // Walk the preceding-slots array from newest backward, counting how
  // many consecutive zeros we hit before encountering a non-zero slot.
  const window = recent.slice(-RECENT_SLOTS_WINDOW);
  let consecutiveZeros = 0;
  let foundNonZero = false;
  for (let i = window.length - 1; i >= 0; i--) {
    const v = Number(window[i]) || 0;
    if (v <= 0) {
      consecutiveZeros++;
    } else {
      foundNonZero = true;
      break;
    }
  }
  // Only treat as a gap if we walked back through ≥N zeros AND found
  // production further back. If `foundNonZero` is false, all visible
  // history is zero — that's nighttime/dawn, not a gap.
  const isRealGap =
    foundNonZero && consecutiveZeros >= CONSECUTIVE_ZEROS_FOR_GAP;
  if (isRealGap && inc > ceilings.postGapThreshold) {
    return {
      rawInc: inc,
      ceilingKwh: ceilings.postGapThreshold,
      tripped: true,
      reason: "gap_backfill",
      overage: inc - ceilings.postGapThreshold,
      appliedInc: 0,
      consecutiveZeros,
      gapMinutes: consecutiveZeros * 5,
      inWarmUp: false,
      historyDepth: recent.length,
      unitsCount: ceilings.unitsCount,
      ratedKw: ceilings.ratedKw,
    };
  }

  return {
    rawInc: inc,
    ceilingKwh: ceilings.physicalCeiling,
    tripped: false,
    reason: "",
    overage: 0,
    appliedInc: inc,
    consecutiveZeros,
    gapMinutes: consecutiveZeros * 5,
    inWarmUp: false,
    historyDepth: recent.length,
    unitsCount: ceilings.unitsCount,
    ratedKw: ceilings.ratedKw,
  };
}

module.exports = {
  INVERTER_MAX_KW,
  UNIT_RATED_KW,
  BUCKET_CEILING_SAFETY,
  POST_GAP_FRACTION,
  RECOVERY_CLAMP_SAFETY,
  FRAME_DT_FLOOR_S,
  MAX_BUCKET_KWH_PER_INVERTER,
  RECENT_SLOTS_WINDOW,
  WARM_UP_SLOTS,
  CONSECUTIVE_ZEROS_FOR_GAP,
  POST_GAP_KWH_THRESHOLD,
  maxRecoveryDeltaKwhForDt,
  classifyRecoveryDelta,
  classifyBucketInc,
  bucketCeilingsForUnits,
};
