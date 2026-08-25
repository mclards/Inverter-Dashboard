"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  RAW_INT16_MIN,
  RAW_INT16_MAX,
  rawToVar,
  rawToKVar,
  kvarToRaw,
  varToRaw,
  maxRawForNominalPowerW,
} = require("../reactivePowerScalingCore");

console.log("\n  reactivePowerScalingCore.test.js — Slice ζ + reg 30069\n");

/* ── READ side: raw × 10 = VAr (PDF symmetry with PAC + Nominal Power) ── */

test("rawToVar: zero stays zero", () => {
  assert.equal(rawToVar(0), 0);
});

test("rawToVar: small positive raw scales by 10", () => {
  assert.equal(rawToVar(1), 10);
  assert.equal(rawToVar(100), 1000);
});

test("rawToVar: 244-kW inverter at full reactive ≈ 24,400 raw → 244 kVAr", () => {
  // For a 244-kW inverter the nominal raw cap (per cmd 9 limit) is
  // round(244000 / 10) = 24400. At that raw, VAr = 244000 = 244 kVAr.
  assert.equal(rawToVar(24400), 244000);
});

test("rawToVar: negative raw (leading PF — absorbing) preserves sign", () => {
  assert.equal(rawToVar(-1000), -10000);
});

test("rawToVar: NaN-safe on garbage input", () => {
  assert.ok(Number.isNaN(rawToVar(NaN)));
  assert.ok(Number.isNaN(rawToVar(undefined)));
});

test("rawToKVar: regression — operator types 50 kVAr → raw 5000 → reads 50 kVAr", () => {
  // Round-trip: kVAr → raw → kVAr should match.
  const raw = kvarToRaw(50);
  assert.equal(raw, 5000);
  assert.equal(rawToKVar(raw), 50);
});

/* ── WRITE side: kVAr × 100 = raw ──────────────────────────────────────── */

test("kvarToRaw: 1 kVAr → raw 100 (NOT raw 10 — that was the bug)", () => {
  assert.equal(kvarToRaw(1), 100);
});

test("kvarToRaw: 25 kVAr → raw 2500", () => {
  assert.equal(kvarToRaw(25), 2500);
});

test("kvarToRaw: -50 kVAr (leading) → raw -5000", () => {
  assert.equal(kvarToRaw(-50), -5000);
});

test("kvarToRaw: clamps to Int16 range", () => {
  assert.equal(kvarToRaw(500),  RAW_INT16_MAX);   // would be 50000
  assert.equal(kvarToRaw(-500), RAW_INT16_MIN);   // would be -50000
});

test("kvarToRaw: NaN-safe on garbage input", () => {
  assert.equal(kvarToRaw(NaN), 0);
  assert.equal(kvarToRaw("abc"), 0);
});

test("varToRaw: 10 000 VAr (= 10 kVAr) → raw 1000", () => {
  assert.equal(varToRaw(10000), 1000);
});

/* ── Per-inverter nominal-power cap (cmd 9 LIMIT) ──────────────────────── */

test("maxRawForNominalPowerW: 244 kW inverter → cap 24 400", () => {
  assert.equal(maxRawForNominalPowerW(244000), 24400);
});

test("maxRawForNominalPowerW: 1 MW inverter caps at Int16 max (32767)", () => {
  // 1_000_000 / 10 = 100_000 — well above Int16 max, so the floor wins.
  assert.equal(maxRawForNominalPowerW(1_000_000), RAW_INT16_MAX);
});

test("maxRawForNominalPowerW: missing nominal falls back to Int16 max", () => {
  assert.equal(maxRawForNominalPowerW(undefined), RAW_INT16_MAX);
  assert.equal(maxRawForNominalPowerW(0), RAW_INT16_MAX);
});

/* ── Documentary anchors — fail loudly if the convention reverts ───────── */

test("CONVENTION GUARD: rawToKVar(100) === 1.0 (not 10.0 — that was the bug)", () => {
  assert.equal(rawToKVar(100), 1.0);
  assert.notEqual(rawToKVar(100), 10.0);
});

test("CONVENTION GUARD: kvarToRaw(50) === 5000 (not 500 — that was the bug)", () => {
  assert.equal(kvarToRaw(50), 5000);
  assert.notEqual(kvarToRaw(50), 500);
});
