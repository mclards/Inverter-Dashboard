"use strict";

/**
 * Slice γ unit tests — inverter state bitfield decoder
 *
 * Tests the decodeInverterState helper that decodes Modbus register 30074 (Estado)
 * into structured form per the official Ingeteam INGECON SUN PDF:
 *   Low byte (bits 0-7) — operating phase (mutually exclusive):
 *     0x00 = initial, 0x01 = magnetizing, 0x02 = connected, 0x03 = error
 *   High byte (bits 8-15) — status flags (combinable):
 *     bit 0 (0x0100) = Stop, bit 1 (0x0200) = Blocked, bit 2 (0x0400) = Grid fault
 *
 * Related plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice γ
 */

const assert = require("assert");

// Import the poller module and extract the decodeInverterState + parseRow helpers.
delete require.cache[require.resolve("../poller")];
const pollerModule = require("../poller");
const { decodeInverterState, parseRow } = pollerModule;

// Helper to create a minimal valid identity for parseRow
function makeIdentity(inverter = 1, unit = 1, sourceIp = "192.168.1.10") {
  return {
    ok: true,
    inverter,
    unit,
    sourceIp,
  };
}

// Helper to create a minimal valid row with all required fields
function makeRow(overrides = {}) {
  return {
    vdc: 800,
    idc: 5,
    vac1: 230, vac2: 231, vac3: 229,
    iac1: 4.3, iac2: 4.4, iac3: 4.2,
    pac: 1000,
    alarm: 0,
    on_off: 1,
    ts: Date.now(),
    ...overrides,
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function run() {
  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  inverterStateDecode.test.js — Slice γ state bitfield");
  console.log("──────────────────────────────────────────────────────────\n");

  // ─────────────────────────────────────────────────────────────────────────
  // PHASE DECODING TESTS (5)
  // ─────────────────────────────────────────────────────────────────────────

  test("decodeInverterState(0x0000): phase='initial', phaseCode=0, no flags", () => {
    const s = decodeInverterState(0x0000);
    assert.strictEqual(s.phase, "initial");
    assert.strictEqual(s.phaseCode, 0);
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
    assert.strictEqual(s.raw, 0x0000);
  });

  test("decodeInverterState(0x0001): phase='magnetizing', phaseCode=1", () => {
    const s = decodeInverterState(0x0001);
    assert.strictEqual(s.phase, "magnetizing");
    assert.strictEqual(s.phaseCode, 1);
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
  });

  test("decodeInverterState(0x0002): phase='connected', phaseCode=2", () => {
    const s = decodeInverterState(0x0002);
    assert.strictEqual(s.phase, "connected");
    assert.strictEqual(s.phaseCode, 2);
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
  });

  test("decodeInverterState(0x0003): phase='error', phaseCode=3", () => {
    const s = decodeInverterState(0x0003);
    assert.strictEqual(s.phase, "error");
    assert.strictEqual(s.phaseCode, 3);
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
  });

  test("decodeInverterState(0x0004): phase='unknown', phaseCode=-1", () => {
    const s = decodeInverterState(0x0004);
    assert.strictEqual(s.phase, "unknown");
    assert.strictEqual(s.phaseCode, -1);
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // STATUS FLAG TESTS (6)
  // ─────────────────────────────────────────────────────────────────────────

  test("decodeInverterState(0x0102): stop=true, phase='connected'", () => {
    const s = decodeInverterState(0x0102);
    assert.strictEqual(s.phase, "connected");
    assert.strictEqual(s.stop, true);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
  });

  test("decodeInverterState(0x0202): blocked=true, phase='connected'", () => {
    const s = decodeInverterState(0x0202);
    assert.strictEqual(s.phase, "connected");
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, true);
    assert.strictEqual(s.gridFault, false);
  });

  test("decodeInverterState(0x0402): gridFault=true, phase='connected'", () => {
    const s = decodeInverterState(0x0402);
    assert.strictEqual(s.phase, "connected");
    assert.strictEqual(s.stop, false);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, true);
  });

  test("decodeInverterState(0x0702): all three flags=true, phase='connected'", () => {
    const s = decodeInverterState(0x0702);
    assert.strictEqual(s.phase, "connected");
    assert.strictEqual(s.stop, true);
    assert.strictEqual(s.blocked, true);
    assert.strictEqual(s.gridFault, true);
  });

  test("decodeInverterState(0x0103): stop=true, phase='error'", () => {
    const s = decodeInverterState(0x0103);
    assert.strictEqual(s.phase, "error");
    assert.strictEqual(s.stop, true);
    assert.strictEqual(s.blocked, false);
    assert.strictEqual(s.gridFault, false);
  });

  test("decodeInverterState(0x0700): all flags=true, phase='initial'", () => {
    const s = decodeInverterState(0x0700);
    assert.strictEqual(s.phase, "initial");
    assert.strictEqual(s.stop, true);
    assert.strictEqual(s.blocked, true);
    assert.strictEqual(s.gridFault, true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EDGE CASE TESTS (5)
  // ─────────────────────────────────────────────────────────────────────────

  test("decodeInverterState(null): phase='unknown', raw=null", () => {
    const s = decodeInverterState(null);
    assert.strictEqual(s.phase, "unknown");
    assert.strictEqual(s.phaseCode, -1);
    assert.strictEqual(s.raw, null);
  });

  test("decodeInverterState(undefined): phase='unknown'", () => {
    const s = decodeInverterState(undefined);
    assert.strictEqual(s.phase, "unknown");
    assert.strictEqual(s.phaseCode, -1);
  });

  test("decodeInverterState(NaN): phase='unknown'", () => {
    const s = decodeInverterState(NaN);
    assert.strictEqual(s.phase, "unknown");
    assert.strictEqual(s.phaseCode, -1);
  });

  test("decodeInverterState('0x0202' as string): phase='unknown' (strict numeric only)", () => {
    const s = decodeInverterState("0x0202");
    assert.strictEqual(s.phase, "unknown");
    assert.strictEqual(s.phaseCode, -1);
  });

  test("decodeInverterState(0x10000 overflow): masks to 0x0000 → phase='initial'", () => {
    const s = decodeInverterState(0x10000);
    assert.strictEqual(s.phase, "initial");
    assert.strictEqual(s.phaseCode, 0);
    assert.strictEqual(s.raw, 0x0000);
  });

  test("decodeInverterState(-1): masks to 0xFFFF → phase='unknown', phaseCode=-1", () => {
    const s = decodeInverterState(-1);
    assert.strictEqual(s.phase, "unknown");
    assert.strictEqual(s.phaseCode, -1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PARSEROW INTEGRATION TESTS (3)
  // ─────────────────────────────────────────────────────────────────────────

  test("parseRow with inverter_state_raw=0x0202: result.inverter_state.blocked===true", () => {
    const row = makeRow({ inverter_state_raw: 0x0202 });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    assert(result.inverter_state !== null, "inverter_state is null");
    assert.strictEqual(result.inverter_state.blocked, true);
    assert.strictEqual(result.inverter_state.phase, "connected");
  });

  test("parseRow without inverter_state_raw: result.inverter_state===null", () => {
    const row = makeRow({});
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    assert.strictEqual(result.inverter_state, null, "Expected inverter_state to be null when field missing");
  });

  test("parseRow with inverter_state_raw=0: result.inverter_state===null (offline marker)", () => {
    const row = makeRow({ inverter_state_raw: 0 });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    assert.strictEqual(result.inverter_state, null, "Expected inverter_state to be null when raw=0 (offline)");
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  All tests completed");
  console.log("──────────────────────────────────────────────────────────\n");
}

run();
