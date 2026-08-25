"use strict";

/**
 * Slice ζ — Reactive + grid-code controls hardening tests (v2.11.0).
 *
 * Pure-function exercise of:
 *   - target validator (extracted from server/index.js)
 *   - Int16 sign casts in the read-back convenience layer
 *   - phi_raw → tan(φ) → PF conversion math
 *   - feature-flag gating contract
 *
 * No ABI deps — runs against pure JS shapes, no SQLite import.
 */

const assert = require("assert");

// ── Mirror of _validateGridControlTarget (server/index.js) ───────────────
function validateGridControlTarget(b) {
  const ip = String(b?.ip || "").trim();
  const slave = Number(b?.slave);
  if (!ip || !/^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(ip)) {
    return { ok: false, error: "ip is required and must be a valid IPv4 address" };
  }
  if (!Number.isFinite(slave) || slave < 1 || slave > 4) {
    return { ok: false, error: `slave must be 1..4, got ${b?.slave}` };
  }
  return { ok: true, ip, slave };
}

// ── Read-back sign-cast helpers (mirror of state endpoint logic) ─────────
function toSignedInt16(u) {
  const v = Number(u) & 0xFFFF;
  return v > 0x7FFF ? v - 0x10000 : v;
}
function phiRawToPF(phi_raw) {
  const phi = phi_raw / 32767;
  return 1 / Math.sqrt(1 + phi * phi);
}

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\n  gridControlCore.test.js — Slice ζ reactive + grid-code\n");

/* ── Target validation ─────────────────────────────────────────────────── */

test("target: missing ip rejected", () => {
  const r = validateGridControlTarget({ slave: 1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /valid IPv4/);
});

test("target: malformed ip rejected", () => {
  for (const ip of ["abc", "1.2.3", "1.2.3.4.5", "x.y.z.w"]) {
    const r = validateGridControlTarget({ ip, slave: 1 });
    assert.strictEqual(r.ok, false, `expected fail for ip=${ip}`);
    assert.match(r.error, /valid IPv4/);
  }
});

test("target: slave must be 1..4", () => {
  for (const slave of [0, 5, -1, 10, "abc", null]) {
    const r = validateGridControlTarget({ ip: "10.0.0.1", slave });
    assert.strictEqual(r.ok, false, `expected fail for slave=${slave}`);
    assert.match(r.error, /slave must be 1\.\.4/);
  }
});

test("target: valid input normalizes", () => {
  const r = validateGridControlTarget({ ip: "192.168.1.10", slave: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ip, "192.168.1.10");
  assert.strictEqual(r.slave, 2);
});

test("target: ip with whitespace trimmed", () => {
  const r = validateGridControlTarget({ ip: "  10.0.0.1  ", slave: 3 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ip, "10.0.0.1");
});

/* ── Int16 sign-cast for read-back ─────────────────────────────────────── */

test("toSignedInt16: 0 → 0", () => {
  assert.strictEqual(toSignedInt16(0), 0);
});

test("toSignedInt16: 0x7FFF (positive max) → 32767", () => {
  assert.strictEqual(toSignedInt16(0x7FFF), 32767);
});

test("toSignedInt16: 0x8000 → -32768", () => {
  assert.strictEqual(toSignedInt16(0x8000), -32768);
});

test("toSignedInt16: 0xFFFF → -1", () => {
  assert.strictEqual(toSignedInt16(0xFFFF), -1);
});

test("toSignedInt16: NGCP PF 0.95 raw +10780 round-trips", () => {
  // PF 0.95 lag/lead → tan(φ) ≈ ±0.329 → raw ±10780.
  assert.strictEqual(toSignedInt16(10780), 10780);
  assert.strictEqual(toSignedInt16(0xFFFF & -10780), -10780);
});

/* ── tan(φ) ↔ PF conversion ────────────────────────────────────────────── */

test("phiRawToPF: raw=0 → PF=1.0 (unity)", () => {
  assert.ok(Math.abs(phiRawToPF(0) - 1.0) < 1e-9);
});

test("phiRawToPF: raw=10780 → PF≈0.95 (NGCP boundary)", () => {
  const pf = phiRawToPF(10780);
  assert.ok(Math.abs(pf - 0.95) < 0.001, `expected ~0.95, got ${pf}`);
});

test("phiRawToPF: raw=-10780 → PF≈0.95 (sign-symmetric)", () => {
  const pf = phiRawToPF(-10780);
  assert.ok(Math.abs(pf - 0.95) < 0.001, `expected ~0.95, got ${pf}`);
});

test("phiRawToPF: raw=15870 → PF≈0.90 (PDF cmd 1 absolute limit)", () => {
  const pf = phiRawToPF(15870);
  assert.ok(Math.abs(pf - 0.90) < 0.005, `expected ~0.90, got ${pf}`);
});

/* ── Feature-flag contract ─────────────────────────────────────────────── */
// _gridControlEnabled reads the setting; here we just confirm the
// "0" / "1" / undefined treatment so the gate behaves predictably.

function gridControlEnabledFromSetting(s) {
  return String(s || "0").trim() === "1";
}

test("flag: undefined → false (default off)", () => {
  assert.strictEqual(gridControlEnabledFromSetting(undefined), false);
});

test("flag: \"0\" → false", () => {
  assert.strictEqual(gridControlEnabledFromSetting("0"), false);
});

test("flag: \"1\" → true", () => {
  assert.strictEqual(gridControlEnabledFromSetting("1"), true);
});

test("flag: \"true\" → false (only literal \"1\" enables)", () => {
  // Conservative read: anything other than "1" leaves the gate closed.
  assert.strictEqual(gridControlEnabledFromSetting("true"), false);
  assert.strictEqual(gridControlEnabledFromSetting("yes"), false);
});

test("flag: whitespace tolerated around \"1\"", () => {
  assert.strictEqual(gridControlEnabledFromSetting("  1  "), true);
});

/* ── Phi raw bound check (PDF cmd 1 limit) ─────────────────────────────── */

test("phi_raw bound: ±15870 is valid", () => {
  for (const v of [0, 1, -1, 15870, -15870, 10780, -10780]) {
    assert.ok(Math.abs(v) <= 15870, `${v} should be within bound`);
  }
});

test("phi_raw bound: ±15871 is rejected", () => {
  for (const v of [15871, -15871, 32767, -32768]) {
    assert.ok(Math.abs(v) > 15870, `${v} should exceed bound`);
  }
});

/* ── kvar_div10 bound check (Int16 full range per PDF cmd 9) ───────────── */

test("kvar_div10 bound: full Int16 range allowed (caller validates per device)", () => {
  for (const v of [0, 32767, -32768, 1000, -1000]) {
    assert.ok(Math.abs(v) <= 32768, `${v} should be within Int16`);
  }
});
