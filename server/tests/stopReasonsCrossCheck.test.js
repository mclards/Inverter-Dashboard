"use strict";

/**
 * Slice ε unit tests — standard-Modbus stop-reason cross-check logic
 *
 * Tests the crossCheckStopReasons() function that compares vendor SCOPE
 * stop-reason records against standard-Modbus slots to detect firmware bugs
 * or Modbus corruption.
 *
 * Related plan: plans/slice-epsilon-implementation.md §8
 */

const assert = require("assert");

// Will fail on first run (RED) — module does not exist yet
let crossCheckStopReasons;
try {
  const mod = require("../stopReasonsCrossCheck");
  crossCheckStopReasons = mod.crossCheckStopReasons;
} catch (err) {
  console.error(`FAILED TO IMPORT: ${err.message}`);
  process.exitCode = 1;
  process.exit(1);
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    if (err.stack) {
      console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    }
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  stopReasonsCrossCheck.test.js — Slice ε cross-check");
  console.log("──────────────────────────────────────────────────────────\n");

  // ─────────────────────────────────────────────────────────────────────────
  // Match rule 1: Both have valid timestamps + codes within tolerance
  // ─────────────────────────────────────────────────────────────────────────

  test("match=true: vendor and std within 60s, same motive code", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,  // MOTIVO_PARO_TEMPERATURA
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1005000,  // +5 s
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, true, "should match within 60s tolerance");
    assert.strictEqual(result.reason, undefined, "no reason on match");
  });

  test("match=true: vendor and std at exact same time", () => {
    const vendor = {
      event_at_ms: 1234567890,
      motparo: 1,  // MOTIVO_PARO_VIN
    };
    const std = {
      timestamp_iso: "2026-02-20T14:22:10Z",
      captured_at_ms: 1234567890,  // exact match
      motive_code: 1,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, true);
  });

  test("match=true: vendor and std at -60s boundary (acceptable)", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 10,  // MOTIVO_PARO_PARO_MANUAL
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1060000,  // +60 s exactly
      motive_code: 10,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, true, "60s boundary should be acceptable");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Mismatch rule 1: Different motive codes
  // ─────────────────────────────────────────────────────────────────────────

  test("match=false: different motive codes", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1005000,
      motive_code: 5,  // Different code
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.codeMatchOk, false);
    assert.strictEqual(result.reason, "code_mismatch");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Mismatch rule 2: Timestamps > 60s apart
  // ─────────────────────────────────────────────────────────────────────────

  test("match=false: timestamps > 60s apart", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1061001,  // +61.001 s
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.timeMatchOk, false);
    assert.strictEqual(result.reason, "timestamp_mismatch");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Offline / invalid data handling
  // ─────────────────────────────────────────────────────────────────────────

  test("match=false: std is offline (captured_at_ms=null or -1)", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "offline",
      captured_at_ms: null,
      motive_code: -1,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.reason, "offline_slot");
  });

  test("match=false: vendor event_at_ms is missing/null", () => {
    const vendor = {
      event_at_ms: null,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1000000,
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.reason, "missing_vendor_data");
  });

  test("match=false: vendor motparo code is missing/null", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: null,
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1000000,
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.reason, "missing_vendor_data");
  });

  test("match=false: invalid std timestamp_iso string", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "invalid(2026-01-15T10:30:45)",  // Invalid marker
      captured_at_ms: null,
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert.strictEqual(result.reason, "invalid_std_timestamp");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Delta structure verification (when match=true)
  // ─────────────────────────────────────────────────────────────────────────

  test("delta contains timeDeltaMs and boolean flags on match", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1005000,
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, true);
    assert.strictEqual(typeof result.delta.timeDeltaMs, "number");
    assert.strictEqual(result.delta.timeDeltaMs, 5000);
    assert.strictEqual(result.delta.timeMatchOk, true);
    assert.strictEqual(result.delta.codeMatchOk, true);
  });

  test("delta on mismatch contains detailed breakdown", () => {
    const vendor = {
      event_at_ms: 1000000,
      motparo: 7,
    };
    const std = {
      timestamp_iso: "2026-01-15T10:30:45Z",
      captured_at_ms: 1061001,
      motive_code: 7,
    };
    const result = crossCheckStopReasons(vendor, std);
    assert.strictEqual(result.match, false);
    assert(result.delta, "delta should exist even on mismatch");
    assert.strictEqual(result.delta.timeMatchOk, false);
    assert.strictEqual(result.delta.codeMatchOk, true);
  });
}

run();
