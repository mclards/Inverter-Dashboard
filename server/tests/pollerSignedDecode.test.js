"use strict";

/**
 * Slice α unit tests — Int16 sign extension for Modbus input registers in poller.js
 *
 * Registers marked "signed yes" in the official Ingeteam INGECON SUN PDF
 * (docs/IngeconSunPMax-Entire-Modbus-RTU-Registers.pdf §2 pg 4-5):
 *   - Reg 30010 (addr 9) `Idc`  — DC input current, 0.1 A/LSB
 *   - Reg 30019 (addr 18) `PAC` — AC output power, tens of W
 * Currently decoded as unsigned UInt16; Slice α applies two's complement.
 *
 * Related plan: plans/2026-05-10-modbus-registers-official-revamp.md §4 Slice α
 */

const assert = require("assert");

// Import the poller module and extract the _signedInt16 helper.
delete require.cache[require.resolve("../poller")];
const pollerModule = require("../poller");
const { _signedInt16, parseRow } = pollerModule;

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
  console.log("  pollerSignedDecode.test.js — Slice α Int16 sign extension");
  console.log("──────────────────────────────────────────────────────────\n");

  // Test _signedInt16 helper directly
  test("_signedInt16: 0xFFF0 → -16 (Idc negative)", () => {
    assert.strictEqual(_signedInt16(0xFFF0), -16);
  });

  test("_signedInt16: 0x8000 → -32768 (min Int16)", () => {
    assert.strictEqual(_signedInt16(0x8000), -32768);
  });

  test("_signedInt16: 0x7FFF → 32767 (max Int16)", () => {
    assert.strictEqual(_signedInt16(0x7FFF), 32767);
  });

  test("_signedInt16: 0 → 0", () => {
    assert.strictEqual(_signedInt16(0), 0);
  });

  test("_signedInt16: 1 → 1 (no sign extension)", () => {
    assert.strictEqual(_signedInt16(1), 1);
  });

  test("_signedInt16: 0xFFFF → -1", () => {
    assert.strictEqual(_signedInt16(0xFFFF), -1);
  });

  // Test parseRow with signed idc and pac
  test("parseRow: idc = 0xFFF0 → result.idc === -16", () => {
    const row = makeRow({ idc: 0xFFF0 });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    assert.strictEqual(result.idc, -16);
  });

  test("parseRow: pac = 0x8000 (signed -32768) → safePac = -327680 (scaled)", () => {
    const row = makeRow({ pac: 0x8000 });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    // -32768 * 10 = -327680 (less than 260000 limit, so not clamped)
    assert.strictEqual(result.pac, -327680, `Expected -327680, got ${result.pac}`);
  });

  test("parseRow: pac = positive max 0x7FFF → safePac = 327670 (scaled)", () => {
    const row = makeRow({ pac: 0x7FFF });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    // 32767 * 10 = 327670 W > 260000 W ceiling, so safePac is clamped to 0.
    assert.strictEqual(result.pac, 0, `Expected 0 (clamped), got ${result.pac}`);
  });

  test("parseRow: pac = 0 → safePac = 0", () => {
    const row = makeRow({ pac: 0 });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    assert.strictEqual(result.pac, 0);
  });

  test("parseRow: idc and pac both signed → both decoded correctly", () => {
    const row = makeRow({ idc: 0xFFF0, pac: 0xFFF0 });
    const identity = makeIdentity();
    const result = parseRow(row, identity);
    assert(result !== null, "parseRow returned null");
    assert.strictEqual(result.idc, -16);
    // -16 * 10 = -160 (negative, not clamped)
    assert.strictEqual(result.pac, -160);
  });

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("  All tests completed");
  console.log("──────────────────────────────────────────────────────────\n");
}

run();
