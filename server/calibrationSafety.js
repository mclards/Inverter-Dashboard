"use strict";

/**
 * server/calibrationSafety.js — TrinPM20 per-offset write-safety gates.
 *
 * Plan: plans/2026-05-12-inverter-calibration-tool.md §2.4
 *
 * The original calibrationRoutes.js shipped with two enforced gates
 *   (1) critical-block lock, (2) ValidCfgCode sentinel preserved
 *   (3) range-guard ±50 %, (4) adsiMM auth, (5) session-id match)
 * but three gates from the original spec were never wired:
 *
 *   • Inverter must be in RUN state (not error / not stop / not blocked)
 *   • Fesc_ipv (DC current scale, offset 87) write requires Pac ≥ 70 % Pn
 *     so the IPV scale read-back is in the high-accuracy band the PDF
 *     specifies (TrinPM20 page on "DC SETTING" workflow)
 *   • Reactive-curve writes need consign at the matching setpoint
 *       offsets 91/92 → X1/Y1 require Pac ≈ 20 % Pn
 *       offsets 93/94 → X2/Y2 require Pac ≈ 70 % Pn
 *
 * This module exposes one pure function — `evaluateWriteSafety(offset,
 * liveSnapshot)` — that returns the per-offset writability verdict. The
 * route layer calls it before each write; if `ok=false` and the caller
 * has not passed `force_safety_gate=true`, the write is refused with a
 * 409 explaining which gate fired.
 *
 * Pure-function, no DB / no Modbus — testable from a fixture object.
 */

// Inverter Estado bitfield (reg 30074). Low byte = phase, high byte = flags.
//   phase: 0=initial, 1=initial-magnetization, 2=grid-connected, 3=error
//   bit 8 = stop, bit 9 = blocked, bit 10 = grid fault
const STATE_PHASE_GRID_CONNECTED = 2;
const STATE_PHASE_ERROR          = 3;

// TrinPM20 DC SETTING. Follow the video SCRIPT (operator directive
// 2026-05-17): the DC input-current (Ipv) scale is calibrated at consign
// 60 % Pn. The "≥ 70 %" mentioned in the video is the ambient-irradiation
// precondition for the NEIGHBOURING inverters, not the consign for the unit
// under calibration. So Ipv is a TARGET BAND around 60 % (like the reactive
// points), NOT a "≥ X %" minimum — enable the write only when live Pac/Pn
// is in the 60 % band, else block. Audit:
// audits/2026-05-17/display-firmware-reactive-blink-logic.md §10.3.
const FESC_IPV_OFFSET            = 87;
const FESC_IPV_TARGET_PCT        = 60.0;
const FESC_IPV_TOLERANCE_PCT_PP  = 5.0;   // 55–65 % — dwell-settled ripple

// Reactive-curve calibration points per TrinPM20:
//   X1Y1 at 20 % Pn (offsets 91, 92)
//   X2Y2 at 70 % Pn (offsets 93, 94)
const REACTIVE_X1Y1_OFFSETS = new Set([91, 92]);
const REACTIVE_X2Y2_OFFSETS = new Set([93, 94]);
const REACTIVE_X1Y1_TARGET_PCT = 20.0;
const REACTIVE_X2Y2_TARGET_PCT = 70.0;
// Tolerance window — the PAC reading must be within ±5 pp of the consign
// target. Mirrors the dwell-settled accuracy band on the field.
const REACTIVE_TOLERANCE_PCT_PP = 5.0;

// Per. Vacio (offset 90) — no-load / self-consumption compensation.
// CORRECTION 2026-05-17 (operator directive): this IS a writable register
// (ISM CfgTrifAU `comp_per_vacio`). The TrinPM20 procedure calibrates it
// with the inverter NOT generating — operator "set consign to 0 %", reads
// the wattmeter, trims Per. Vacio until reported Pac matches it. So it is a
// 0 %-consign BAND gate (not generating): too-high Pac/Pn blocks. Band is
// symmetric to tolerate the slightly-negative no-load self-draw.
const PER_VACIO_OFFSET           = 90;
const PER_VACIO_TARGET_PCT       = 0.0;
const PER_VACIO_TOLERANCE_PCT_PP = 5.0;   // −5…+5 % → "not generating"

// Returns { ok, reason, severity } where severity ∈ "block" | "warn".
//
// Intended-purpose correction (operator feedback 2026-05-16): voltage and
// current SCALE-FACTOR calibration (Vac1-3 / Iac1-3) is legitimately and
// routinely performed while the inverter is OFF-GRID (initial / init-mag
// phase, zero Pac) — you trim the ADC scale against an external meter, not
// against the grid. The previous code hard-BLOCKED every write whenever
// the inverter wasn't grid-connected, which forced the operator to arm the
// "bypass TrinPM20 safety gate" checkbox on literally every write. That
// defeats the gate's purpose.
//
// So: genuinely unsafe states (state unreadable / ERROR / BLOCKED / GRID
// FAULT) remain a hard BLOCK. "Not grid-connected" but otherwise healthy
// is downgraded to a non-blocking WARN — the write proceeds, the operator
// is informed, no Force toggle required. The offsets that DO need a real
// power band (Fesc_ipv ≥ 70 %, reactive X1Y1/X2Y2) keep their own hard
// block below; those are the actual TrinPM20 constraints.
function _stateOk(live) {
  if (!live) return { ok: false, severity: "block", reason: "no live snapshot" };
  if (live.state_raw == null) {
    return { ok: false, severity: "block", reason: "Inverter state register unreadable" };
  }
  if (Number(live.state_phase) === STATE_PHASE_ERROR) {
    return { ok: false, severity: "block", reason: "Inverter is in ERROR phase" };
  }
  if (Number(live.state_blocked) === 1) {
    return { ok: false, severity: "block", reason: "Inverter is BLOCKED" };
  }
  if (Number(live.state_grid_fault) === 1) {
    return { ok: false, severity: "block", reason: "Inverter reports GRID FAULT" };
  }
  if (Number(live.state_phase) !== STATE_PHASE_GRID_CONNECTED) {
    // Off-grid is normal for scale calibration — warn, do not block.
    return {
      ok: false,
      severity: "warn",
      reason: `Inverter not grid-connected (phase=${live.state_phase}) — scale calibration is valid off-grid; reading may be quieter than at load`,
    };
  }
  // bit 8 = stop. Calibration writes during stop are allowed for some
  // offsets (Per. Vacio in standby) — we don't refuse on `stop` here;
  // that's an offset-level decision below.
  return { ok: true };
}

/**
 * @param {number} offset
 * @param {object|null} live
 *   { state_raw, state_phase, state_stop, state_blocked, state_grid_fault,
 *     pac_w, nominal_power_w, pct_of_pn }
 * @returns {{ offset:number, ok:boolean, severity:"info"|"warn"|"block",
 *             reason:string, required:{pct_of_pn?:[number,number]} }}
 */
function evaluateWriteSafety(offset, live) {
  const off = Number(offset);
  const out = { offset: off, ok: true, severity: "info", reason: "", required: {} };

  const s = _stateOk(live);
  if (!s.ok) {
    out.ok = false;
    // Honor the state verdict's own severity: hard-unsafe states block,
    // "not grid-connected" only warns (write still allowed, no Force).
    out.severity = s.severity === "warn" ? "warn" : "block";
    out.reason = s.reason;
    return out;
  }

  const pct = live && live.pct_of_pn != null ? Number(live.pct_of_pn) : null;

  // DC current scale (Fesc_ipv) — calibrated at the consign 60 % point per
  // the TrinPM20 video script. Band gate (like reactive), NOT a minimum:
  // too LOW and too HIGH are both wrong consign targets.
  if (off === FESC_IPV_OFFSET) {
    const ipvLo = FESC_IPV_TARGET_PCT - FESC_IPV_TOLERANCE_PCT_PP;
    const ipvHi = FESC_IPV_TARGET_PCT + FESC_IPV_TOLERANCE_PCT_PP;
    if (pct == null) {
      out.ok = false;
      out.severity = "warn";
      out.reason = `Cannot verify Pac/Pn (nominal power read failed) — Ipv calibrates at consign ${FESC_IPV_TARGET_PCT} % (${ipvLo}–${ipvHi} %)`;
      out.required.pct_of_pn = [ipvLo, ipvHi];
      return out;
    }
    if (pct < ipvLo || pct > ipvHi) {
      out.ok = false;
      out.severity = "block";
      out.reason = `Pac/Pn = ${pct.toFixed(1)} % — TrinPM20 calibrates DC current (Ipv) at consign ${FESC_IPV_TARGET_PCT} % (${ipvLo}–${ipvHi} %); set consign to 60 % first`;
      out.required.pct_of_pn = [ipvLo, ipvHi];
      return out;
    }
  }

  if (REACTIVE_X1Y1_OFFSETS.has(off) || REACTIVE_X2Y2_OFFSETS.has(off)) {
    const target = REACTIVE_X1Y1_OFFSETS.has(off)
      ? REACTIVE_X1Y1_TARGET_PCT : REACTIVE_X2Y2_TARGET_PCT;
    const lo = target - REACTIVE_TOLERANCE_PCT_PP;
    const hi = target + REACTIVE_TOLERANCE_PCT_PP;
    if (pct == null) {
      out.ok = false;
      out.severity = "warn";
      out.reason = `Cannot verify Pac/Pn (nominal power read failed) — required ${lo}–${hi} %`;
      out.required.pct_of_pn = [lo, hi];
      return out;
    }
    if (pct < lo || pct > hi) {
      out.ok = false;
      out.severity = "block";
      out.reason = `Pac/Pn = ${pct.toFixed(1)} % — TrinPM20 reactive ${REACTIVE_X1Y1_OFFSETS.has(off) ? "X1Y1" : "X2Y2"} calibration requires ${target} ± ${REACTIVE_TOLERANCE_PCT_PP} % (consign mode)`;
      out.required.pct_of_pn = [lo, hi];
      return out;
    }
  }

  // Per. Vacio (offset 90) — no-load / self-consumption comp. TrinPM20
  // calibrates this with the inverter NOT generating (operator sets consign
  // to 0 %); you then trim Per. Vacio until reported Pac matches the
  // wattmeter. Band gate around 0 % (too-high Pac/Pn = still generating →
  // block). Bypassable like the other consign gates (NOT a hard refusal —
  // that earlier non-bypassable lock on 90 was the bug being corrected).
  if (off === PER_VACIO_OFFSET) {
    const pvLo = PER_VACIO_TARGET_PCT - PER_VACIO_TOLERANCE_PCT_PP;
    const pvHi = PER_VACIO_TARGET_PCT + PER_VACIO_TOLERANCE_PCT_PP;
    if (pct == null) {
      out.ok = false;
      out.severity = "warn";
      out.reason = `Cannot verify Pac/Pn (nominal power read failed) — Per. Vacio calibrates with the inverter not generating (consign 0 %, ${pvLo}–${pvHi} %)`;
      out.required.pct_of_pn = [pvLo, pvHi];
      return out;
    }
    if (pct < pvLo || pct > pvHi) {
      out.ok = false;
      out.severity = "block";
      out.reason = `Pac/Pn = ${pct.toFixed(1)} % — TrinPM20 calibrates Per. Vacio (no-load comp) with the inverter NOT generating; set consign to 0 % first (${pvLo}–${pvHi} %)`;
      out.required.pct_of_pn = [pvLo, pvHi];
      return out;
    }
  }

  return out;
}

/**
 * Build a per-field writability map for the read endpoint — UI can render
 * each Write button with the gate's verdict in advance, so the operator
 * sees red/amber/green before clicking.
 *
 * @param {object} live
 * @param {number[]} offsets
 * @returns {Object<number, ReturnType<typeof evaluateWriteSafety>>}
 */
function buildWriteSafetyMap(live, offsets) {
  const out = {};
  for (const off of offsets || []) {
    out[Number(off)] = evaluateWriteSafety(off, live);
  }
  return out;
}

module.exports = {
  evaluateWriteSafety,
  buildWriteSafetyMap,
  // Exposed for tests
  FESC_IPV_OFFSET,
  FESC_IPV_TARGET_PCT,
  FESC_IPV_TOLERANCE_PCT_PP,
  REACTIVE_X1Y1_OFFSETS,
  REACTIVE_X2Y2_OFFSETS,
  REACTIVE_X1Y1_TARGET_PCT,
  REACTIVE_X2Y2_TARGET_PCT,
  REACTIVE_TOLERANCE_PCT_PP,
  PER_VACIO_OFFSET,
  PER_VACIO_TARGET_PCT,
  PER_VACIO_TOLERANCE_PCT_PP,
  STATE_PHASE_GRID_CONNECTED,
  STATE_PHASE_ERROR,
};
