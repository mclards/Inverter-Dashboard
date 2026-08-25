"use strict";

// Pure conversions for INGECON SUN reactive-power register/command scaling.
//
// One source of truth so the UI, server, Python helper, and compliance
// reports cannot drift apart again. Background and the off-by-100 incident
// it replaces:
//   audits/2026-05-11/register-decode-traceback.md  Findings 1 + 2.
//
// PDF references (docs/IngeconSunPMax-Modbus-pg07.txt + pg16.txt):
//
//   30019 Power     "in tens of Watt"            → raw × 10 = W   (validated)
//   30077 Nominal   "Nominal power DIV 10"       → raw × 10 = W   (validated)
//   30069 QAC       "Reactive power DIV 10"      → raw × 10 = VAr (by symmetry)
//   cmd 9 Reactive  "React. power in (KVAr/10)" → raw × 10 = VAr (by symmetry,
//                   plus the LIMIT field "Nominal power of the inverter div 10"
//                   = the same value as reg 30077, which already scales by 10)
//
// Convention (single rule for read & write):
//
//   raw_int16  ×  10  =  VAr
//   ⇒ kVAr  =  raw / 100
//   ⇒ raw  =  round(kVAr × 100)
//
// Sign convention preserved: positive raw = lagging (Q > 0, inverter injects
// reactive power); negative raw = leading (Q < 0, inverter absorbs).
//
// ────────────────────────────────────────────────────────────────────────────
// Earlier (broken) convention, removed 2026-05-11:
//
//   raw / 10 = VAr      (read side — qac_var came back 100× too small)
//   raw     = kVAr × 10 (write side — operator typed kVAr but got 0.1×)
//
// Both directions were off by the same factor, so the dashboard's Q-V chart
// looked self-consistent but every absolute number was wrong. Tests in
// reactivePowerScalingCore.test.js + gridControlCore.test.js lock the new
// math and FAIL if anyone slips back.

const RAW_INT16_MIN = -32768;
const RAW_INT16_MAX =  32767;

function _toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function _clampRaw(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < RAW_INT16_MIN) return RAW_INT16_MIN;
  if (v > RAW_INT16_MAX) return RAW_INT16_MAX;
  return Math.round(v);
}

// READ side ----------------------------------------------------------------

// Convert a register-decoded raw Int16 (from QAC reg 30069 or cmd 9 read-back
// reg 41008) into reactive power expressed in VAr.
function rawToVar(raw) {
  const r = _toFiniteNumber(raw);
  if (!Number.isFinite(r)) return NaN;
  return r * 10;
}

// Same value, expressed in kVAr.
function rawToKVar(raw) {
  const r = _toFiniteNumber(raw);
  if (!Number.isFinite(r)) return NaN;
  return r / 100;
}

// WRITE side ---------------------------------------------------------------

// Convert an operator-supplied kVAr setpoint to the raw Int16 the cmd 9 wire
// expects. Result is clamped to Int16 range; callers should additionally
// apply per-inverter nominal-power limits derived from reg 30077.
function kvarToRaw(kvar) {
  const k = _toFiniteNumber(kvar);
  if (!Number.isFinite(k)) return 0;
  return _clampRaw(k * 100);
}

// Same, but expects VAr instead of kVAr.
function varToRaw(varVal) {
  const v = _toFiniteNumber(varVal);
  if (!Number.isFinite(v)) return 0;
  return _clampRaw(v / 10);
}

// Per-inverter limit: nominal_power_w / 10 (matches the PDF's
// "Nominal power of the inverter div 10" cap on cmd 9 raw values).
function maxRawForNominalPowerW(nominalPowerW) {
  const n = _toFiniteNumber(nominalPowerW);
  if (!Number.isFinite(n) || n <= 0) return RAW_INT16_MAX;
  return Math.min(RAW_INT16_MAX, Math.round(n / 10));
}

module.exports = {
  RAW_INT16_MIN,
  RAW_INT16_MAX,
  rawToVar,
  rawToKVar,
  kvarToRaw,
  varToRaw,
  maxRawForNominalPowerW,
};
