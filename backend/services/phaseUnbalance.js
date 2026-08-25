"use strict";

/**
 * phaseUnbalance.js — Slice κ.8 (v2.11.x), 2026-05-12.
 *
 * Physical-measurement gate on the critical-alarm auto-block. Operator
 * field history (2026-05-12 conversation): the alarm bit patterns
 * 0x0240 / 0x0210 have been firing on the fleet for over a year without
 * any actual hardware failure following them. So those bits alone are not
 * reliable predictors of impending damage — they're better understood as
 * "watch" signals. The ONE measurement that genuinely tracks bond-wire /
 * substrate failure progression is **AC phase current unbalance**: when
 * one IGBT leg starts degrading, that phase stops carrying its share of
 * the load, and the unbalance percentage rises steadily before
 * catastrophic failure.
 *
 * Gating rule wired in by criticalPatternEnforcer.decideBlockAction:
 *   open_block fires ONLY when both
 *     (a) a critical alarm pattern recurs (existing Slice κ.3 rule), AND
 *     (b) phase-current unbalance is SUSTAINED above threshold on the
 *         same slave at the time of decision.
 * Either signal alone stays at "watch" severity. The dashboard still
 * surfaces the alarm-pattern severity in the UI so operators know what's
 * happening — we just no longer auto-STOP for it.
 *
 * Pure functions only. Callers fetch rows from inverter_5min_param and
 * inject `now` for deterministic testing.
 *
 *   inverter_5min_param schema (server/db.js):
 *     iac1_a, iac2_a, iac3_a  — per-phase AC amps (REAL)
 *     pac_w                    — node active power, watts (INTEGER)
 *     in_solar_window          — 1 inside solar window, 0 outside
 *     date_local, slot_index   — 5-min slot keying
 *     updated_ts               — ms epoch
 */

// Per-slot threshold: a slot is "unbalanced" when
//   (Imax - Imin) / Iavg ≥ DEFAULT_UNBALANCE_PCT_THRESHOLD / 100
// 20% is the operator-agreed starting line. A healthy three-phase inverter
// at >10% load typically runs <5% unbalance; 10-15% is "watch", and >20%
// sustained is a meaningful physical signal of a degrading leg.
const DEFAULT_UNBALANCE_PCT_THRESHOLD = 20;

// Sustained means: at least this many consecutive 5-min slots over
// threshold. 2 slots ≈ 10 minutes of unbalance — enough to rule out a
// single-slot transient (cloud edge, brief grid asymmetry, partial
// dispatch) and short enough to react before serious damage.
const DEFAULT_MIN_SUSTAINED_SLOTS = 2;

// Below this average phase current the unbalance percentage is dominated
// by measurement noise (each leg quantizes to ~0.1 A) and slot-edge
// effects. Skip the unbalance evaluation when the inverter isn't
// generating meaningful power. 5 A average ≈ 3.3 kW at 220 V per phase.
const DEFAULT_MIN_IAC_AVG_A = 5.0;

// Absolute power floor. Use both this and the Iac floor — they catch
// different edge cases. At <10 kW, even a real ~25% unbalance is
// physically insignificant (the bridge isn't stressed enough for
// degradation to be progressing).
const DEFAULT_MIN_PAC_W = 10_000;

// Below the noise floor we treat the phase as effectively zero and the
// unbalance ratio as invalid (Imin can be a quantization-only artefact).
const NOISE_IAC_A = 0.5;

/**
 * computeUnbalanceFromRow(row) → { valid, unbalance_pct, iavg_a, pac_w, why? }
 *
 * Pure per-slot evaluation. `row` is one inverter_5min_param row (or a
 * test object with the same field names).
 *
 *   valid=false means the slot must NOT be counted toward sustained-ness:
 *     - any phase below noise floor (operating asymmetrically — not a
 *       hardware fault, more often a startup / dropout state)
 *     - average AC current below DEFAULT_MIN_IAC_AVG_A
 *     - pac_w below DEFAULT_MIN_PAC_W
 *     - in_solar_window === 0 (don't blame unbalance outside solar window)
 *     - any field non-finite
 *
 *   When valid=true, `unbalance_pct = (Imax - Imin) / Iavg * 100`.
 */
function computeUnbalanceFromRow(row, opts) {
  const o = opts || {};
  const minIacAvg = Number.isFinite(Number(o.minIacAvgA))
    ? Number(o.minIacAvgA)
    : DEFAULT_MIN_IAC_AVG_A;
  const minPacW = Number.isFinite(Number(o.minPacW))
    ? Number(o.minPacW)
    : DEFAULT_MIN_PAC_W;

  const i1 = Number(row?.iac1_a);
  const i2 = Number(row?.iac2_a);
  const i3 = Number(row?.iac3_a);
  const pacW = Number(row?.pac_w);
  const inSolar = Number(row?.in_solar_window);

  if (!Number.isFinite(i1) || !Number.isFinite(i2) || !Number.isFinite(i3)) {
    return { valid: false, unbalance_pct: 0, iavg_a: 0, pac_w: pacW || 0, why: "non_finite_iac" };
  }
  if (!Number.isFinite(pacW)) {
    return { valid: false, unbalance_pct: 0, iavg_a: 0, pac_w: 0, why: "non_finite_pac" };
  }
  if (inSolar === 0) {
    return { valid: false, unbalance_pct: 0, iavg_a: 0, pac_w: pacW, why: "outside_solar_window" };
  }
  if (i1 <= NOISE_IAC_A || i2 <= NOISE_IAC_A || i3 <= NOISE_IAC_A) {
    return { valid: false, unbalance_pct: 0, iavg_a: 0, pac_w: pacW, why: "phase_below_noise" };
  }
  if (pacW < minPacW) {
    return { valid: false, unbalance_pct: 0, iavg_a: 0, pac_w: pacW, why: "pac_below_floor" };
  }

  const iavg = (i1 + i2 + i3) / 3;
  if (iavg < minIacAvg) {
    return { valid: false, unbalance_pct: 0, iavg_a: iavg, pac_w: pacW, why: "iavg_below_floor" };
  }

  const imax = Math.max(i1, i2, i3);
  const imin = Math.min(i1, i2, i3);
  const pct  = ((imax - imin) / iavg) * 100;
  return { valid: true, unbalance_pct: pct, iavg_a: iavg, pac_w: pacW };
}

/**
 * evaluateSustainedUnbalance(rows, opts?) → {
 *   sustained, max_pct, slots_evaluated, slots_over_threshold,
 *   threshold_pct, min_sustained_slots, samples
 * }
 *
 * `rows` should be most-recent-first (DESC by updated_ts / slot_index).
 * We walk from newest backward and count consecutive valid slots whose
 * unbalance_pct meets the threshold. Invalid slots (noise floor, low pac,
 * outside solar window) reset the streak — they are not over-threshold
 * but also not safely under, so they don't help either side.
 *
 * `sustained=true` only when streak ≥ DEFAULT_MIN_SUSTAINED_SLOTS.
 */
function evaluateSustainedUnbalance(rows, opts) {
  const o = opts || {};
  const threshold = Number.isFinite(Number(o.thresholdPct))
    ? Number(o.thresholdPct)
    : DEFAULT_UNBALANCE_PCT_THRESHOLD;
  const minSustained = Number.isFinite(Number(o.minSustainedSlots)) && o.minSustainedSlots > 0
    ? Math.floor(Number(o.minSustainedSlots))
    : DEFAULT_MIN_SUSTAINED_SLOTS;

  const out = {
    sustained: false,
    max_pct: 0,
    slots_evaluated: 0,
    slots_over_threshold: 0,
    threshold_pct: threshold,
    min_sustained_slots: minSustained,
    samples: [],
  };

  if (!Array.isArray(rows) || rows.length === 0) return out;

  let streak = 0;
  let maxStreak = 0;
  let firstStreakBroken = false;
  for (const row of rows) {
    const r = computeUnbalanceFromRow(row, o);
    out.slots_evaluated++;
    out.samples.push({
      valid: r.valid,
      unbalance_pct: Number(r.unbalance_pct.toFixed(2)),
      iavg_a: Number(r.iavg_a.toFixed(3)),
      pac_w: r.pac_w,
      why: r.why || null,
    });
    if (r.valid && r.unbalance_pct >= threshold) {
      out.slots_over_threshold++;
      if (out.max_pct < r.unbalance_pct) out.max_pct = r.unbalance_pct;
      if (!firstStreakBroken) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      }
    } else {
      // First non-over slot from the freshest direction ends the
      // "current" streak. We still track later runs for forensic stats
      // but they don't count for sustained-now.
      firstStreakBroken = true;
    }
  }
  out.sustained = streak >= minSustained;
  out.max_pct = Number(out.max_pct.toFixed(2));
  return out;
}

module.exports = {
  DEFAULT_UNBALANCE_PCT_THRESHOLD,
  DEFAULT_MIN_SUSTAINED_SLOTS,
  DEFAULT_MIN_IAC_AVG_A,
  DEFAULT_MIN_PAC_W,
  NOISE_IAC_A,
  computeUnbalanceFromRow,
  evaluateSustainedUnbalance,
};
