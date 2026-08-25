"use strict";

/**
 * server/serialFixedMap.js
 *
 * Canonical, operator-authoritative per-inverter serial numbers.
 * SINGLE SOURCE OF TRUTH: docs/Fixed_Inverter_SerialNumbers.xlsx
 * (the permanent field guide). Regenerated 2026-05-19 after the
 * operator corrected the Inverter 2 / Inverter 14 typos in that file —
 * every entry is now a clean 12-char Motorola serial, no exceptions.
 * Do NOT hand-edit; regenerate from the xlsx whenever it changes.
 *
 * Shape: FIXED_SERIAL_MAP[inverterId] = {
 *   T:        "serial",   // whole-inverter nameplate — REFERENCE ONLY,
 *                          // never written (no Modbus slave for "T")
 *   "1".."4": "serial"    // Modbus slaves 1..4 (writable nodes)
 * }
 *
 * Invariants (locked by server/tests/serialBulkMap.test.js):
 *   • 27 inverters, each with T + nodes 1..4 (135 entries).
 *   • Every serial is exactly 12 ASCII printable chars (Motorola).
 *   • All 135 serials are globally unique — the numbering is locked
 *     even when a physical node is absent (its serial stays reserved,
 *     never reused), which is what powers relocation detection.
 */

const FIXED_SERIAL_MAP = Object.freeze({
  1: { T: "400152914R90", "1": "400152914R91", "2": "400152914R92", "3": "400152914R93", "4": "400152914R94" },
  2: { T: "400152A18R00", "1": "400152A18R01", "2": "400152A18R02", "3": "400152A18R03", "4": "400152A18R04" },
  3: { T: "400152915R80", "1": "400152915R81", "2": "400152915R82", "3": "400152915R83", "4": "400152915R84" },
  4: { T: "400152915R40", "1": "400152915R41", "2": "400152915R42", "3": "400152915R43", "4": "400152915R44" },
  5: { T: "400152A18R30", "1": "400152A18R31", "2": "400152A18R32", "3": "400152A18R33", "4": "400152A18R34" },
  6: { T: "400152A18R10", "1": "400152A18R11", "2": "400152A18R12", "3": "400152A18R13", "4": "400152A18R14" },
  7: { T: "400152915R60", "1": "400152915R61", "2": "400152915R62", "3": "400152915R63", "4": "400152915R64" },
  8: { T: "400152A17R70", "1": "400152A17R71", "2": "400152A17R72", "3": "400152A17R73", "4": "400152A17R74" },
  9: { T: "400152A17R50", "1": "400152A17R51", "2": "400152A17R52", "3": "400152A17R53", "4": "400152A17R54" },
  10: { T: "400152915R00", "1": "400152915R01", "2": "400152915R02", "3": "400152915R03", "4": "400152915R04" },
  11: { T: "400152915R30", "1": "400152915R31", "2": "400152915R32", "3": "400152915R33", "4": "400152915R34" },
  12: { T: "400152A17R60", "1": "400152A17R61", "2": "400152A17R62", "3": "400152A17R63", "4": "400152A17R64" },
  13: { T: "400152A18R60", "1": "400152A18R61", "2": "400152A18R62", "3": "400152A18R63", "4": "400152A18R64" },
  14: { T: "400152A17R30", "1": "400152A17R31", "2": "400152A17R32", "3": "400152A17R33", "4": "400152A17R34" },
  15: { T: "400152A17R10", "1": "400152A17R11", "2": "400152A17R12", "3": "400152A17R13", "4": "400152A17R14" },
  16: { T: "400152A16R90", "1": "400152A16R91", "2": "400152A16R92", "3": "400152A16R93", "4": "400152A16R94" },
  17: { T: "400152A17R00", "1": "400152A17R01", "2": "400152A17R02", "3": "400152A17R03", "4": "400152A17R04" },
  18: { T: "400152915R10", "1": "400152915R11", "2": "400152915R12", "3": "400152915R13", "4": "400152915R14" },
  19: { T: "400152A17R20", "1": "400152A17R21", "2": "400152A17R22", "3": "400152A17R23", "4": "400152A17R24" },
  20: { T: "400152A17R80", "1": "400152A17R81", "2": "400152A17R82", "3": "400152A17R83", "4": "400152A17R84" },
  21: { T: "400152A18R40", "1": "400152A18R41", "2": "400152A18R42", "3": "400152A18R43", "4": "400152A18R44" },
  22: { T: "400152915R70", "1": "400152915R71", "2": "400152915R72", "3": "400152915R73", "4": "400152915R74" },
  23: { T: "400152915R50", "1": "400152915R51", "2": "400152915R52", "3": "400152915R53", "4": "400152915R54" },
  24: { T: "400152915R20", "1": "400152915R21", "2": "400152915R22", "3": "400152915R23", "4": "400152915R24" },
  25: { T: "400152A17R90", "1": "400152A17R91", "2": "400152A17R92", "3": "400152A17R93", "4": "400152A17R94" },
  26: { T: "400152A18R20", "1": "400152A18R21", "2": "400152A18R22", "3": "400152A18R23", "4": "400152A18R24" },
  27: { T: "400152A18R50", "1": "400152A18R51", "2": "400152A18R52", "3": "400152A18R53", "4": "400152A18R54" },
});

// Format is Motorola (12-char) for the whole fleet (FreescaleDSP56F).
const FIXED_SERIAL_FMT = "motorola";

// Writable Modbus slaves per inverter. "T" is intentionally excluded —
// it is the inverter nameplate label, not an addressable slave.
const WRITABLE_NODES = Object.freeze([1, 2, 3, 4]);

function getTargetSerial(inverterId, slave) {
  const inv = FIXED_SERIAL_MAP[Number(inverterId)];
  if (!inv) return null;
  const s = inv[String(slave)];
  return typeof s === "string" ? s : null;
}

// ─── Reverse index: serial → the slot it belongs to ──────────────────────
//
// Every one of the 135 serials is globally unique, so a serial read off a
// live node unambiguously identifies which (inverter, node) slot that
// physical module/nameplate was assigned at the factory. This powers
// relocation detection: if Inverter 27 / Node 2 currently reports the
// serial the map assigns to Inverter 4 / Node 1, that power module was
// physically moved there and re-serializing it must be acknowledged and
// its origin logged. `kind` is "node" for slaves 1..4, "nameplate" for
// the "T" reference serial.
const SERIAL_ORIGIN = (() => {
  const idx = new Map();
  for (const invIdStr of Object.keys(FIXED_SERIAL_MAP)) {
    const invId = Number(invIdStr);
    for (const k of ["T", "1", "2", "3", "4"]) {
      idx.set(FIXED_SERIAL_MAP[invId][k], {
        inverter: invId,
        node: k === "T" ? "T" : Number(k),
        kind: k === "T" ? "nameplate" : "node",
      });
    }
  }
  return idx;
})();

// Resolve a serial to its factory slot, or null if not in the locked map
// at all (factory-default / never-serialized / foreign board).
function lookupSerialOrigin(serial) {
  const s = String(serial || "").trim();
  if (!s) return null;
  return SERIAL_ORIGIN.get(s) || null;
}

module.exports = {
  FIXED_SERIAL_MAP,
  FIXED_SERIAL_FMT,
  WRITABLE_NODES,
  getTargetSerial,
  lookupSerialOrigin,
};
