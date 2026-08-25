"use strict";

/**
 * apcRampLimiter.js — paces Active Power Control setpoint writes so the
 * absolute change per minute never exceeds the operator-configured limit.
 *
 * Plan: plans/2026-05-12-ppc-capabilities-implementation.md §3
 *
 * Why: the inverter accepts step setpoints instantly via Modbus cmd 3. A
 * 100→0% step is technically valid but creates a steep dP/dt that can
 * destabilise PCC voltage and trip protection on adjacent feeders. NGCP
 * PGC §4.4.4.6 prescribes ramp-rate control for utility-scale PV; we
 * implement a soft, software-side throttle that ALWAYS converges on the
 * requested target — never blocks the operator.
 *
 * Pure module: no DB, no timers, no Modbus. Caller (plantCapController)
 * invokes planRamp() and decides whether to schedule the intermediate
 * writes.
 *
 * Contract:
 *   planRamp({
 *     current_pct,         // last known active power %  (0..100)
 *     target_pct,          // operator-requested final %  (0..100)
 *     rate_pct_per_min,    // configured limit            (1..100)
 *     step_interval_ms,    // tick cadence; default 15 s
 *     now_ms,              // for deterministic tests
 *   })
 *   →
 *   {
 *     immediate_pct,       // value to write RIGHT NOW
 *     remaining_steps,     // array of { delay_ms, pct } scheduled after immediate
 *     throttled,           // true if the path took > 1 step
 *     total_duration_ms,
 *   }
 *
 * Behaviour:
 *   - rate_pct_per_min ≤ 0 or non-finite → disable throttle (single immediate step).
 *   - |target − current| ≤ step_pct (= rate × interval/60) → single immediate step.
 *   - otherwise → multiple steps each ≤ step_pct, evenly spaced by step_interval_ms.
 *   - Final step ALWAYS lands exactly on target_pct (no float drift).
 */

const DEFAULT_STEP_INTERVAL_MS = 15_000;     // 15 s between paced steps
const ABSOLUTE_MIN_STEP_PCT    = 0.5;        // never plan sub-half-pct steps
const MAX_PLAN_STEPS           = 60;          // safety: cap horizon at 60 steps (~15 min @ 15 s)

function _toFinite(v) {
  // STRICT null/undefined check: Number(null) === 0, but a missing
  // current_pct is operationally "unknown" — NOT zero. Treating it as 0
  // generates spurious 0→target ramp plans on first start.
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function planRamp(args) {
  const a = args || {};
  const current = _toFinite(a.current_pct);
  const target  = _toFinite(a.target_pct);
  const rate    = _toFinite(a.rate_pct_per_min);
  const interval = Math.max(500, _toFinite(a.step_interval_ms) || DEFAULT_STEP_INTERVAL_MS);
  const now = _toFinite(a.now_ms) ?? Date.now();

  // Defensive: no current → cannot meaningfully throttle. Apply target directly.
  if (current == null || target == null) {
    return {
      immediate_pct: target,
      remaining_steps: [],
      throttled: false,
      total_duration_ms: 0,
      reason: "missing_current_or_target",
    };
  }
  // Clamp to physical setpoint range — defence in depth (callers also validate).
  const t = Math.max(0, Math.min(100, target));
  const c = Math.max(0, Math.min(100, current));

  // Disabled / unusable rate → ship target straight to the inverter.
  if (rate == null || rate <= 0) {
    return {
      immediate_pct: t,
      remaining_steps: [],
      throttled: false,
      total_duration_ms: 0,
      reason: "rate_disabled",
    };
  }

  const delta = t - c;
  const absDelta = Math.abs(delta);
  // Step size per interval = rate × interval-minutes.
  const stepPct = Math.max(ABSOLUTE_MIN_STEP_PCT, rate * (interval / 60_000));

  if (absDelta <= stepPct) {
    return {
      immediate_pct: t,
      remaining_steps: [],
      throttled: false,
      total_duration_ms: 0,
      reason: "delta_within_step",
    };
  }

  // Number of steps required = ceil(delta / stepPct). Cap at MAX_PLAN_STEPS:
  // beyond that horizon the operator can re-issue without the limiter.
  const ideal = Math.ceil(absDelta / stepPct);
  const nSteps = Math.min(ideal, MAX_PLAN_STEPS);
  // Recompute the actual per-step magnitude so the plan lands EXACTLY on target.
  const sign = delta > 0 ? 1 : -1;
  const perStepMag = absDelta / nSteps;

  const remaining = [];
  // Steps 1..nSteps-1 are scheduled; step 0 is immediate.
  let lastPct = c;
  for (let i = 1; i <= nSteps; i++) {
    const next = (i === nSteps) ? t : (c + sign * perStepMag * i);
    // Index 0 is the "immediate" write (i === 1 means the FIRST paced step
    // happens at interval ms from now). We schedule i ≥ 2 as remaining; the
    // i === 1 step we return as immediate_pct.
    if (i === 1) {
      lastPct = next;
    } else {
      remaining.push({
        delay_ms: interval * (i - 1),
        pct: next,
      });
    }
  }

  return {
    immediate_pct: lastPct,
    remaining_steps: remaining,
    throttled: true,
    total_duration_ms: interval * (nSteps - 1),
    reason: "throttled",
    plan_meta: {
      step_pct: perStepMag,
      step_count: nSteps,
      direction: sign > 0 ? "up" : "down",
      now_ms: now,
    },
  };
}

module.exports = {
  planRamp,
  DEFAULT_STEP_INTERVAL_MS,
  ABSOLUTE_MIN_STEP_PCT,
  MAX_PLAN_STEPS,
};
