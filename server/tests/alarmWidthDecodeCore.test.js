"use strict";

// 2.1 — alarm bitfield is the FULL 32-bit regs 6-7 value. decodeAlarm() and
// formatAlarmHex() must handle high-word bits (16-31) without sign/truncation
// loss so multi-alarm combinations are logged/exported accurately.
// Requires alarms.js (→ db.js) so it runs under the Node-ABI smoke harness.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.NODE_ENV = "test";
if (!process.env.IM_PORTABLE_DATA_DIR) {
  process.env.IM_PORTABLE_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "adsi-alarm-width-"),
  );
}
fs.mkdirSync(path.join(process.env.IM_PORTABLE_DATA_DIR, "config"), {
  recursive: true,
});

const { decodeAlarm, formatAlarmHex, ALARM_BITS } = require("../alarms.js");

function run() {
  console.log("[Test] alarmWidthDecodeCore");

  // A bit in the HIGH word (bit >= 16) must decode if the catalogue defines
  // one. Pick the highest-defined bit to prove no 16-bit truncation.
  const maxBit = Math.max(...ALARM_BITS.map((b) => Number(b.bit)));
  assert.ok(Number.isFinite(maxBit), "ALARM_BITS must define numeric bits");

  // Low-word sanity: 0x0240 (bits 6 + 9) decodes to exactly those bits.
  {
    const bits = decodeAlarm(0x0240).map((b) => b.bit).sort((a, b) => a - b);
    assert.deepStrictEqual(bits, [6, 9], "0x0240 → bits 6 & 9");
  }

  // Combination spanning low + high word: bit 0 + the highest catalogue bit.
  if (maxBit >= 16) {
    const val = (1 + 2 ** maxBit) >>> 0; // bit 0 + highest catalogue bit
    const decoded = decodeAlarm(val).map((b) => b.bit);
    assert.ok(decoded.includes(0), "low bit 0 decodes in a 32-bit combo");
    assert.ok(
      decoded.includes(maxBit),
      `high-word bit ${maxBit} decodes (no 16-bit truncation)`,
    );
  } else {
    console.log(`  (catalogue max bit = ${maxBit}; high-word case skipped)`);
  }

  // Unsigned 32-bit safety: bit 31 set (value > 2^31) must not be lost to
  // signed-shift. decodeAlarm coerces via >>> 0, so a bit-31 catalogue entry
  // (if any) decodes; either way the call must not throw and must be stable.
  const big = 0x80000001 >>> 0; // bit 31 + bit 0
  const d = decodeAlarm(big);
  assert.ok(Array.isArray(d), "decodeAlarm tolerates bit-31 values");
  assert.ok(d.some((b) => b.bit === 0), "bit 0 still decodes alongside bit 31");

  // formatAlarmHex must NOT truncate a 32-bit value to 4 hex digits.
  const hex = formatAlarmHex(0x00120240);
  assert.strictEqual(hex, "120240H", `32-bit hex preserved, got ${hex}`);
  assert.strictEqual(formatAlarmHex(0), "0000H");

  console.log("[Test] alarmWidthDecodeCore: PASS");
}

try {
  run();
  process.exit(0);
} catch (err) {
  console.error("alarmWidthDecodeCore.test.js: FAIL", err?.stack || err);
  process.exit(1);
}
