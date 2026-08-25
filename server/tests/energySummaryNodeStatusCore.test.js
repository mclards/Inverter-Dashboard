"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  classifyEnergySummaryNode,
  BRIEF_WINDOW_MIN_DEFAULT,
  DISCREPANCY_PCT_DEFAULT,
  PEAK_PAC_NOISE_W,
} = require("../energySummaryNodeStatusCore");

const HOUR = 3600 * 1000;
const MIN  = 60 * 1000;
const T0 = 1_700_000_000_000;

test("ACTIVE — full day, PAC ≈ HW", () => {
  const r = classifyEnergySummaryNode({
    sampleCount: 8000,
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * HOUR,
    pacPeakW:  180_000,
    pacKwh:    1500,
    etotalDeltaKwh: 1490,
    parceDeltaKwh:  1490,
  });
  assert.equal(r.status, "ACTIVE");
  assert.ok(Math.abs(r.deltaPct) < 1, `deltaPct ${r.deltaPct}`);
  assert.equal(Math.round(r.windowMinutes), 720);
});

test("BRIEF_RESPONSE — short comm window, zero PAC", () => {
  // The Inv 16 Node 1 case from production: 13 min window @ 05:14, all zero.
  const r = classifyEnergySummaryNode({
    sampleCount: 4,
    firstTsMs: T0,
    lastTsMs:  T0 + 13 * MIN,
    pacPeakW:  0,
    pacKwh:    0,
    etotalDeltaKwh: 0,
    parceDeltaKwh:  0,
  });
  assert.equal(r.status, "BRIEF_RESPONSE");
  assert.match(r.reason, /Modbus comm window/);
  assert.ok(r.windowMinutes > 12 && r.windowMinutes < 14);
});

test("BRIEF_RESPONSE — also fires for noise-floor PAC peak", () => {
  // Comm artefact may report a few-watts peak from quantization noise.
  const r = classifyEnergySummaryNode({
    sampleCount: 6,
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * MIN,
    pacPeakW:  PEAK_PAC_NOISE_W - 10,
    pacKwh:    0,
    etotalDeltaKwh: 0, parceDeltaKwh: 0,
  });
  assert.equal(r.status, "BRIEF_RESPONSE");
});

test("ZERO_PRODUCTION — long window, no PAC (inverter idle/faulted all day)", () => {
  const r = classifyEnergySummaryNode({
    sampleCount: 1500,
    firstTsMs: T0,
    lastTsMs:  T0 + 6 * HOUR,
    pacPeakW:  0,
    pacKwh:    0,
    etotalDeltaKwh: 0, parceDeltaKwh: 0,
  });
  assert.equal(r.status, "ZERO_PRODUCTION");
  assert.match(r.reason, /no PAC|peak PAC/);
});

test("BASELINE_LATE — HW counter under-counts PAC by > 20 %", () => {
  // Inv 12 Node 3 from production: PAC 1.10 MWh vs Etotal 0.574 MWh ≈ -47.8 %.
  const r = classifyEnergySummaryNode({
    sampleCount: 8000,
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * HOUR,
    pacPeakW:  175_000,
    pacKwh:    1100,
    etotalDeltaKwh: 574,
    parceDeltaKwh:  574,
  });
  assert.equal(r.status, "BASELINE_LATE");
  assert.ok(r.deltaPct < -40, `deltaPct ${r.deltaPct}`);
});

test("HW_OVER — HW counter exceeds PAC by > 20 %", () => {
  const r = classifyEnergySummaryNode({
    sampleCount: 8000,
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * HOUR,
    pacPeakW:  180_000,
    pacKwh:    1000,
    etotalDeltaKwh: 1300,
    parceDeltaKwh:  1300,
  });
  assert.equal(r.status, "HW_OVER");
  assert.ok(r.deltaPct > 20);
});

test("ACTIVE — within ±20 % discrepancy band", () => {
  const r = classifyEnergySummaryNode({
    firstTsMs: T0,
    lastTsMs:  T0 + 10 * HOUR,
    pacPeakW:  150_000,
    pacKwh:    1000,
    etotalDeltaKwh: 1150,    // +15 %
  });
  assert.equal(r.status, "ACTIVE");
});

test("ACTIVE when HW deltas are NaN (no comparison possible)", () => {
  // A healthy production day where the HW counter baseline is missing
  // (gateway booted today, no yesterday eod_clean) — must not flag.
  const r = classifyEnergySummaryNode({
    firstTsMs: T0,
    lastTsMs:  T0 + 11 * HOUR,
    pacPeakW:  170_000,
    pacKwh:    1200,
    etotalDeltaKwh: NaN,
    parceDeltaKwh:  NaN,
  });
  assert.equal(r.status, "ACTIVE");
  assert.ok(Number.isNaN(r.deltaPct));
});

test("NO_DATA when sampleCount === 0", () => {
  const r = classifyEnergySummaryNode({
    sampleCount: 0,
    firstTsMs: 0, lastTsMs: 0,
    pacPeakW: 0, pacKwh: 0,
  });
  assert.equal(r.status, "NO_DATA");
});

test("BRIEF_WINDOW threshold is configurable", () => {
  // Same input — 25-min window — flips classification with a tighter threshold.
  const input = {
    firstTsMs: T0, lastTsMs: T0 + 25 * MIN,
    pacPeakW: 0, pacKwh: 0,
  };
  const def = classifyEnergySummaryNode(input);
  assert.equal(def.status, "BRIEF_RESPONSE", "default 30-min threshold");
  const tight = classifyEnergySummaryNode(input, { briefWindowMin: 15 });
  assert.equal(tight.status, "ZERO_PRODUCTION", "tighter 15-min threshold reclassifies");
});

test("Discrepancy threshold is configurable", () => {
  const input = {
    firstTsMs: T0, lastTsMs: T0 + 12 * HOUR,
    pacPeakW: 150_000, pacKwh: 1000,
    etotalDeltaKwh: 880, // -12 %
  };
  const def = classifyEnergySummaryNode(input);
  assert.equal(def.status, "ACTIVE");
  const strict = classifyEnergySummaryNode(input, { discrepancyPct: 0.10 });
  assert.equal(strict.status, "BASELINE_LATE");
});

test("deltaPct is NaN when PAC is too small for meaningful comparison", () => {
  const r = classifyEnergySummaryNode({
    firstTsMs: T0, lastTsMs: T0 + 12 * HOUR,
    pacPeakW: 150_000, pacKwh: 0.01,   // < 0.05 kWh threshold
    etotalDeltaKwh: 100,
  });
  assert.ok(Number.isNaN(r.deltaPct));
  // Still ACTIVE because PAC is non-trivial and we don't have a baseline anchor
  // confident enough to flag — design preserves operator trust.
  assert.equal(r.status, "ACTIVE");
});

test("Defaults expose tunable thresholds for documentation/UI", () => {
  assert.equal(BRIEF_WINDOW_MIN_DEFAULT, 30);
  assert.equal(DISCREPANCY_PCT_DEFAULT, 0.20);
  assert.equal(PEAK_PAC_NOISE_W, 100);
});

/* ── ESTIMATED_FROM_PAC: HW Δ was filled from PAC integral upstream ───── */

test("ESTIMATED_FROM_PAC when hwProvenance='pac_fallback' (Inv 12 Node 3 case)", () => {
  // The exporter filled the HW columns from the same PAC integral that drives
  // Total_MWh, so deltaPct ≈ 0 and the values look identical — but the
  // operator needs to see this is a synthetic anchor, not an independent
  // measurement.
  const r = classifyEnergySummaryNode({
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * HOUR,
    pacPeakW:  175_000,
    pacKwh:    1100,
    etotalDeltaKwh: 1100,    // identical because it WAS the PAC value
    parceDeltaKwh:  1100,
    hwProvenance:   "pac_fallback",
  });
  assert.equal(r.status, "ESTIMATED_FROM_PAC");
  // Reworded (3.1) to plain words — no Δ glyph. Assert the stable phrase.
  assert.match(r.reason, /filled from the PAC-integrated energy/);
});

test("ESTIMATED_FROM_PAC fires BEFORE the discrepancy classifier", () => {
  // A small numeric difference between hwEtotalKwh and pacKwh shouldn't
  // flip the row to BASELINE_LATE when provenance says it was synthetic.
  const r = classifyEnergySummaryNode({
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * HOUR,
    pacPeakW:  150_000,
    pacKwh:    1000,
    etotalDeltaKwh: 500,    // would normally flag BASELINE_LATE
    hwProvenance:   "pac_fallback",
  });
  assert.equal(r.status, "ESTIMATED_FROM_PAC");
});

test("hwProvenance='hw_counter' uses the normal discrepancy classifier", () => {
  const r = classifyEnergySummaryNode({
    firstTsMs: T0,
    lastTsMs:  T0 + 12 * HOUR,
    pacPeakW:  150_000,
    pacKwh:    1000,
    etotalDeltaKwh: 500,
    hwProvenance:   "hw_counter",
  });
  assert.equal(r.status, "BASELINE_LATE");
});

/* ── 3.1: Notes column must be plain words, no symbols/glyphs ─────────── */

test("every reason string is plain ASCII words (no Δ/≤/—/? glyphs)", () => {
  // One representative input per status branch so every operator-facing
  // `reason` is exercised. The Energy Summary "Notes" column renders these
  // verbatim — they must be unambiguous on every locale/codepage.
  const cases = [
    { sampleCount: 0, firstTsMs: 0, lastTsMs: 0, pacPeakW: 0, pacKwh: 0 },                                  // NO_DATA
    { sampleCount: 4, firstTsMs: T0, lastTsMs: T0 + 13 * MIN, pacPeakW: 0, pacKwh: 0 },                     // BRIEF_RESPONSE
    { sampleCount: 1500, firstTsMs: T0, lastTsMs: T0 + 6 * HOUR, pacPeakW: 0, pacKwh: 0 },                  // ZERO_PRODUCTION
    { firstTsMs: T0, lastTsMs: T0 + 12 * HOUR, pacPeakW: 175_000, pacKwh: 1100,                             // ESTIMATED_FROM_PAC
      etotalDeltaKwh: 1100, hwProvenance: "pac_fallback" },
    { sampleCount: 8000, firstTsMs: T0, lastTsMs: T0 + 12 * HOUR, pacPeakW: 175_000, pacKwh: 1100,          // BASELINE_LATE
      etotalDeltaKwh: 574, hwProvenance: "hw_counter" },
    { sampleCount: 8000, firstTsMs: T0, lastTsMs: T0 + 12 * HOUR, pacPeakW: 180_000, pacKwh: 1000,          // HW_OVER
      etotalDeltaKwh: 1300, hwProvenance: "hw_counter" },
    { sampleCount: 8000, firstTsMs: T0, lastTsMs: T0 + 12 * HOUR, pacPeakW: 180_000, pacKwh: 1500,          // ACTIVE
      etotalDeltaKwh: 1490 },
  ];
  const ASCII_WORDS = /^[\x20-\x7E]*$/;          // printable ASCII only
  for (const input of cases) {
    const { status, reason } = classifyEnergySummaryNode(input);
    assert.ok(typeof reason === "string" && reason.length > 0, `${status}: empty reason`);
    assert.ok(ASCII_WORDS.test(reason), `${status}: non-ASCII glyph in reason -> ${reason}`);
    // No speculative trailing question mark — Notes must be definitive.
    assert.ok(!/\?\s*$/.test(reason), `${status}: reason must not end with "?" -> ${reason}`);
    // Explicitly ban the symbols the operator called out.
    for (const bad of ["Δ", "≤", "≥", "−", "—", "≈", "°", "Φ"]) {
      assert.ok(!reason.includes(bad), `${status}: banned glyph ${JSON.stringify(bad)} in reason`);
    }
  }
});
