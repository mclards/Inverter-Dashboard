"use strict";

// F-T1 (audit 2026-05-28 §1.11) — unit-test `_computeSpreadPctCap()` edge
// cases: the dawn/dusk denominator (why plant capacity, not P50, is the
// denominator) and the plantCapMw <= 0 / non-finite guards. This is the
// intentional-FP #1 from §1.7: normalising by plant capacity avoids the
// spread% explosion that P50 -> 0 at dawn/dusk would cause.

const assert = require("assert");
const { _computeSpreadPctCap } = require("../dayAheadLock");

function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

function run() {
  // ── Nominal midday band ──
  // P10=0.40 MW, P90=0.60 MW, cap=0.90692 MW → spread 0.20 / 0.90692 * 100
  {
    const v = _computeSpreadPctCap(0.4, 0.6, 0.90692);
    assert.ok(v !== null, "nominal band should compute");
    assert.ok(approx(v, (0.2 / 0.90692) * 100), "spread% normalised by plant cap");
    assert.ok(v < 30, "midday spread% should be a sane small number");
  }

  // ── Dawn/dusk: tiny P50 but real band — the whole point of cap-normalisation.
  // If P50 (~0.005 MW) were the denominator, spread% would explode to 1000s.
  // With plant cap as denominator it stays bounded and comparable.
  {
    const p10 = 0.001, p90 = 0.010, cap = 0.90692;
    const v = _computeSpreadPctCap(p10, p90, cap);
    assert.ok(v !== null, "dawn band should compute");
    assert.ok(approx(v, ((p90 - p10) / cap) * 100), "dawn spread% uses cap denominator");
    assert.ok(v < 5, "dawn spread% must NOT explode (would be ~180% against a 0.005 P50)");
  }

  // ── plantCapMw <= 0 → null (no division-by-zero / negative blowup) ──
  assert.strictEqual(_computeSpreadPctCap(0.4, 0.6, 0), null, "cap=0 -> null");
  assert.strictEqual(_computeSpreadPctCap(0.4, 0.6, -1), null, "cap<0 -> null");

  // ── Non-finite / missing inputs → null ──
  assert.strictEqual(_computeSpreadPctCap(null, 0.6, 0.9), null, "null p10 -> null");
  assert.strictEqual(_computeSpreadPctCap(0.4, undefined, 0.9), null, "undefined p90 -> null");
  assert.strictEqual(_computeSpreadPctCap(NaN, 0.6, 0.9), null, "NaN p10 -> null");
  assert.strictEqual(_computeSpreadPctCap(0.4, Infinity, 0.9), null, "Infinity p90 -> null");
  assert.strictEqual(_computeSpreadPctCap(0.4, 0.6, NaN), null, "NaN cap -> null");
  assert.strictEqual(_computeSpreadPctCap(0.4, 0.6, "0.9"), null, "string cap -> null (strict finite-number)");

  // ── Inverted band (p90 < p10) still computes a (negative) value, not null —
  // the caller, not this primitive, decides whether to clamp. Documents intent.
  {
    const v = _computeSpreadPctCap(0.6, 0.4, 0.90692);
    assert.ok(v !== null && v < 0, "inverted band yields a negative spread%, not null");
  }

  console.log("dayAheadSpreadCap.test.js: PASS");
}

run();
